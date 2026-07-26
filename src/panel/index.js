import { buildChatGptHandoff, buildConversationMessages } from "../core/conversation.js";
import { isValidBridgeConnectEvent, readBridgeToken } from "../core/bridge.js";
import { dataUrlToBlob } from "../core/data-url.js";
import { ContextFreshness } from "../core/context-freshness.js";
import { renderMessageMarkdown } from "../core/message-renderer.js";
import { OperationGate } from "../core/operation-gate.js";
import { createInertController } from "./inert-controller.js";
import { createMessageSanitizer } from "./rich-text-dom.js";
import {
  assertEndpointSecurity,
  requestChatCompletion,
  resolveChatCompletionsUrl,
} from "../core/openai.js";
import {
  endpointOriginPattern,
  removeEndpointPermission,
  requestEndpointPermission,
  requestEndpointPermissionWithPriorState,
} from "../core/permissions.js";
import {
  boundedImageAttachments,
  buildContextPayload,
  buildUserContent,
} from "../core/prompt.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  providerConfigurationChanged,
  SettingsMutationCoordinator,
} from "../core/settings.js";

const browserApi = globalThis.browser ?? globalThis.chrome;
const demoMode = new URLSearchParams(location.search).has("demo") || !browserApi?.runtime?.id;

const byId = (id) => document.getElementById(id);
const elements = {
  appShell: byId("appShell"),
  topbar: document.querySelector(".topbar"),
  conversation: byId("conversation"),
  emptyState: byId("emptyState"),
  messageList: byId("messageList"),
  newChatButton: byId("newChatButton"),
  settingsButton: byId("settingsButton"),
  closeButton: byId("closeButton"),
  chatgptBanner: byId("chatgptBanner"),
  selectionCard: byId("selectionCard"),
  selectionToggle: byId("selectionToggle"),
  selectionText: byId("selectionText"),
  attachmentStrip: byId("attachmentStrip"),
  composerForm: byId("composerForm"),
  promptInput: byId("promptInput"),
  pageContextToggle: byId("pageContextToggle"),
  captureButton: byId("captureButton"),
  elementButton: byId("elementButton"),
  sendButton: byId("sendButton"),
  providerStatus: byId("providerStatus"),
  openSettingsInline: byId("openSettingsInline"),
  composerDock: document.querySelector(".composer-dock"),
  settingsSheet: byId("settingsSheet"),
  sheetScrim: byId("sheetScrim"),
  closeSettingsButton: byId("closeSettingsButton"),
  settingsForm: byId("settingsForm"),
  baseUrlInput: byId("baseUrlInput"),
  apiKeyInput: byId("apiKeyInput"),
  modelInput: byId("modelInput"),
  streamInput: byId("streamInput"),
  revealKeyButton: byId("revealKeyButton"),
  previewOverlay: byId("previewOverlay"),
  previewImage: byId("previewImage"),
  previewTitle: byId("previewTitle"),
  closePreviewButton: byId("closePreviewButton"),
  copyPreviewButton: byId("copyPreviewButton"),
  toast: byId("toast"),
  contextStateText: byId("contextStateText"),
  liveStatus: byId("liveStatus"),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  page: null,
  selection: "",
  attachments: [],
  history: [],
  contextAvailable: false,
  abortController: null,
  previewAttachmentId: null,
};

const operationGate = new OperationGate();
const settingsMutations = new SettingsMutationCoordinator();
const contextFreshness = new ContextFreshness();
const setElementInert = createInertController(window);
const sanitizeMessageHtml = createMessageSanitizer(window);
const pendingBridgeRequests = new Map();
const expectedBridgeToken = readBridgeToken(location.href);
let bridgePort;
let resolveBridgeReady;
const bridgeReady = new Promise((resolve) => {
  resolveBridgeReady = resolve;
});
let requestSequence = 0;
let toastTimer;
let modalTrigger;

function svgUse(icon) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${icon}`);
  svg.append(use);
  return svg;
}

function demoImage(label, accent = "#d8ff67") {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0f110d"/><stop offset="1" stop-color="#252a20"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/><circle cx="1080" cy="110" r="190" fill="${accent}" opacity=".14"/>
    <rect x="72" y="80" width="1136" height="560" rx="32" fill="#171a14" stroke="#545b49"/>
    <text x="120" y="180" fill="${accent}" font-family="Avenir Next, sans-serif" font-size="28" letter-spacing="5">SAFAI PREVIEW</text>
    <text x="120" y="360" fill="#f4f4e8" font-family="Georgia, serif" font-size="76">${label}</text>
    <text x="120" y="430" fill="#929789" font-family="Avenir Next, sans-serif" font-size="26">Only a local interface preview — no data was sent.</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function demoBridgeResponse(type) {
  if (type === "REQUEST_CONTEXT") {
    return {
      ok: true,
      page: {
        title: "Designing calm software",
        url: "https://example.com/editorial-interface",
        text: "A thoughtful interface makes its data boundaries visible. Controls should be close to the consequence they produce, and context should remain removable before anything is sent.",
      },
      selection: "Controls should be close to the consequence they produce.",
      contextRevision: 0,
    };
  }
  if (type === "CAPTURE_VIEWPORT") {
    return { ok: true, dataUrl: demoImage("Current viewport") };
  }
  if (type === "PICK_ELEMENT") {
    return {
      ok: true,
      cancelled: false,
      dataUrl: demoImage("Selected element", "#ff7863"),
      metadata: {
        element: "button.primary-action",
        label: "Continue",
        text: "Continue",
        path: "main#content > button.primary-action",
      },
    };
  }
  return { ok: true };
}

function handleBridgeMessage(message) {
  if (message.type === "PAGE_CONTEXT_INVALIDATED") {
    contextFreshness.invalidate(message.contextRevision);
    if (!contextFreshness.isFresh) {
      renderContextState("stale");
      renderPageToggle();
    }
    return;
  }
  if (message.type === "SELECTION_CHANGED") {
    state.selection = String(message.selection ?? "");
    renderSelection();
    return;
  }

  if (message.type !== "RESPONSE") return;
  const pending = pendingBridgeRequests.get(message.requestId);
  if (!pending) return;
  pendingBridgeRequests.delete(message.requestId);
  clearTimeout(pending.timeout);
  pending.signal?.removeEventListener("abort", pending.abort);
  if (message.ok) pending.resolve(message);
  else pending.reject(new Error(message.error || "操作失敗"));
}

window.addEventListener("message", (event) => {
  if (!isValidBridgeConnectEvent(event, window.parent, expectedBridgeToken)) return;
  bridgePort?.close();
  bridgePort = event.ports[0];
  bridgePort.onmessage = (portEvent) => handleBridgeMessage(portEvent.data ?? {});
  bridgePort.start();
  resolveBridgeReady?.();
  resolveBridgeReady = undefined;
});

function requestAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

async function requestContent(type, payload = {}, { signal } = {}) {
  if (signal?.aborted) throw requestAbortError(signal);
  if (demoMode) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve(demoBridgeResponse(type));
      };
      const timer = setTimeout(finish, type === "PICK_ELEMENT" ? 650 : 120);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(requestAbortError(signal));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  await new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(new Error("安全連線未建立，請重新開啟 SafAI"));
    }, 15_000);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(requestAbortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    bridgeReady.then(finish);
  });

  return new Promise((resolve, reject) => {
    const requestId = `panel-${Date.now()}-${++requestSequence}`;
    const timeout = setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      signal?.removeEventListener("abort", abort);
      if (type === "PICK_ELEMENT") {
        bridgePort?.postMessage({
          type: "CANCEL_PICKER",
          requestId: `cancel-${requestId}`,
        });
      }
      reject(new Error(type === "PICK_ELEMENT" ? "元素選取已逾時" : "網頁沒有回應"));
    }, type === "PICK_ELEMENT" ? 300_000 : 20_000);

    const abort = () => {
      clearTimeout(timeout);
      pendingBridgeRequests.delete(requestId);
      signal?.removeEventListener("abort", abort);
      reject(requestAbortError(signal));
    };

    pendingBridgeRequests.set(requestId, { resolve, reject, timeout, signal, abort });
    signal?.addEventListener("abort", abort, { once: true });
    bridgePort.postMessage({ type, requestId, ...payload });
  });
}

function showToast(message, type = "info") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", type === "error");
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2800);
}

async function loadSettings() {
  if (demoMode) return { ...DEFAULT_SETTINGS };
  try {
    const saved = await browserApi.storage.local.get("settings");
    return mergeSettings(saved.settings);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function persistSettings(settings = state.settings) {
  if (demoMode) return;
  await browserApi.storage.local.set({ settings });
}

function updateProviderStatus() {
  if (state.settings.mode === "chatgpt") {
    elements.providerStatus.textContent = "內容會複製到剪貼簿，再開啟 ChatGPT";
    elements.openSettingsInline.textContent = "API 設定";
  } else {
    const model = state.settings.model || "尚未設定模型";
    let destination = "API 位址待設定";
    try {
      destination = new URL(resolveChatCompletionsUrl(state.settings.baseUrl)).host;
    } catch {
      // The settings form will surface the validation error.
    }
    elements.providerStatus.textContent = `${model} · ${destination} · 送出後才傳送`;
    elements.openSettingsInline.textContent = "API 設定";
  }
}

function renderMode() {
  document.querySelectorAll(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === state.settings.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.chatgptBanner.hidden = state.settings.mode !== "chatgpt";
  elements.promptInput.placeholder =
    state.settings.mode === "chatgpt"
      ? "整理內容，複製並開啟 ChatGPT…"
      : "詢問目前頁面的任何事情…";
  updateSendButtonLabel();
  updateProviderStatus();
}

async function applyMode(mode, { save = true } = {}) {
  if (operationGate.kind || settingsMutations.kind) {
    showToast("請先完成或停止目前操作", "error");
    return;
  }
  const nextMode = mode === "chatgpt" ? "chatgpt" : "api";
  const previousMode = state.settings.mode;
  if (nextMode === previousMode) {
    renderMode();
    return;
  }
  const nextSettings = { ...state.settings, mode: nextMode };
  if (!save) {
    state.settings = nextSettings;
    renderMode();
    return;
  }

  const mutation = beginSettingsMutation("mode", nextSettings);
  if (!mutation) return;
  state.settings = nextSettings;
  renderMode();
  try {
    await persistSettings(nextSettings);
    if (!settingsMutations.isCurrent(mutation)) return;
    resetConversationState({ clearDraft: false, clearAttachments: false });
    showToast("已切換模式並開始新對話");
  } catch {
    if (!settingsMutations.isCurrent(mutation)) return;
    state.settings = { ...state.settings, mode: previousMode };
    renderMode();
    showToast("無法儲存使用方式", "error");
  } finally {
    endSettingsMutation(mutation);
  }
}

function renderPageToggle() {
  const enabled = state.settings.includePage;
  const contextReady = state.contextAvailable && contextFreshness.isFresh;
  elements.pageContextToggle.classList.toggle("is-on", enabled);
  elements.pageContextToggle.classList.toggle("is-unavailable", !contextReady);
  elements.pageContextToggle.setAttribute("aria-pressed", String(enabled));
  elements.pageContextToggle.querySelector("b").textContent = enabled ? "ON" : "OFF";
  elements.pageContextToggle.title = contextReady
    ? "附上目前頁面內容"
    : contextFreshness.isFresh
      ? "目前頁面內容暫時無法讀取"
      : "頁面內容已變更，傳送前會重新讀取";
}

function renderContextState(status) {
  if (!elements.contextStateText) return;
  const labels = {
    checking: "CURRENT PAGE · CHECKING",
    ready: "CURRENT PAGE · READY",
    stale: "CURRENT PAGE · CHANGED",
    unavailable: "CURRENT PAGE · UNAVAILABLE",
  };
  elements.contextStateText.textContent = labels[status] ?? labels.unavailable;
  elements.contextStateText.closest(".eyebrow")?.classList.toggle(
    "is-unavailable",
    status === "unavailable" || status === "stale",
  );
}

function renderSelection() {
  const hasSelection = Boolean(state.selection.trim());
  elements.selectionCard.hidden = !hasSelection;
  if (!hasSelection) return;

  elements.selectionText.textContent = state.selection;
  const included = state.settings.includeSelection;
  elements.selectionCard.classList.toggle("is-excluded", !included);
  elements.selectionToggle.classList.toggle("is-on", included);
  elements.selectionToggle.setAttribute("aria-pressed", String(included));
  elements.selectionToggle.querySelector("span").textContent = included ? "會附上" : "不附上";
}

function attachmentName(attachment) {
  if (attachment.kind === "element") return attachment.metadata?.element || "網頁元素";
  return "目前畫面";
}

function renderAttachments() {
  elements.attachmentStrip.replaceChildren();
  elements.attachmentStrip.hidden = state.attachments.length === 0;

  for (const attachment of state.attachments) {
    const card = document.createElement("article");
    card.className = "attachment-card";
    card.dataset.id = attachment.id;

    const image = document.createElement("img");
    image.src = attachment.dataUrl;
    image.alt = attachmentName(attachment);

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "attachment-preview";
    preview.dataset.action = "preview";
    preview.dataset.id = attachment.id;
    preview.setAttribute("aria-label", `預覽${attachmentName(attachment)}`);

    const label = document.createElement("span");
    label.className = "attachment-kind";
    label.textContent = attachment.kind === "element" ? "元素" : "畫面";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.dataset.action = "remove";
    remove.dataset.id = attachment.id;
    remove.setAttribute("aria-label", `移除${attachmentName(attachment)}`);
    remove.append(svgUse("close"));

    card.append(image, preview, label, remove);
    elements.attachmentStrip.append(card);
  }
}

function addAttachment(attachment) {
  if (state.attachments.length >= 4) {
    showToast("每次最多附上 4 張截圖", "error");
    return false;
  }
  const candidate = {
    id: globalThis.crypto?.randomUUID?.() || `attachment-${Date.now()}-${state.attachments.length}`,
    ...attachment,
  };
  const bounded = boundedImageAttachments([...state.attachments, candidate]);
  if (!bounded.includes(candidate)) {
    showToast("截圖過大；請縮小視窗或改為框選較小的元素", "error");
    return false;
  }
  state.attachments.push(candidate);
  renderAttachments();
  return true;
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function latestElementMetadata() {
  return [...state.attachments]
    .reverse()
    .find((attachment) => attachment.kind === "element")?.metadata;
}

function contextLabels() {
  const labels = [];
  if (state.settings.includePage && state.page) labels.push("目前頁面");
  if (state.settings.includeSelection && state.selection.trim()) labels.push("反白文字");
  if (state.attachments.length) labels.push(`${state.attachments.length} 張截圖`);
  return labels;
}

function renderMessageText(message, text, { rich = false } = {}) {
  message.rawText = String(text ?? "");
  message.content.replaceChildren();
  if (!rich || !message.rawText) {
    message.content.textContent = message.rawText;
    return;
  }
  try {
    message.content.append(sanitizeMessageHtml(renderMessageMarkdown(message.rawText)));
  } catch {
    message.content.textContent = message.rawText;
  }
}

function appendMessageCopyButton(message) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-button message-copy";
  copy.setAttribute("aria-label", "複製回覆");
  copy.append(svgUse("copy"));
  copy.addEventListener("click", async () => {
    const copied = await copyText(message.rawText);
    showToast(copied ? "已複製回覆" : "無法存取剪貼簿", copied ? "info" : "error");
  });
  message.meta.append(copy);
}

function addMessage(role, text, { labels = [], error = false, pending = false } = {}) {
  elements.emptyState.hidden = true;
  const article = document.createElement("article");
  article.className = `message ${role}${error ? " is-error" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.textContent = role === "user" ? "YOU" : error ? "ERROR" : "SAFAI";
  meta.append(name);

  const bubble = document.createElement("div");
  bubble.className = `message-bubble${pending ? " typing-caret" : ""}`;
  const content = document.createElement("div");
  content.className = "message-content";
  bubble.append(content);
  const message = { article, bubble, content, meta, rawText: "" };
  renderMessageText(message, text, { rich: !pending });

  if (role === "assistant" && message.rawText) appendMessageCopyButton(message);

  if (labels.length) {
    const context = document.createElement("div");
    context.className = "message-context";
    for (const label of labels) {
      const badge = document.createElement("span");
      badge.textContent = label;
      context.append(badge);
    }
    bubble.append(context);
  }

  article.append(meta, bubble);
  elements.messageList.append(article);
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
  return message;
}

function updateAssistantMessage(message, text, { error = false, complete = false } = {}) {
  renderMessageText(message, text, { rich: complete || error });
  message.bubble.classList.toggle("typing-caret", !complete && !error);
  message.article.classList.toggle("is-error", error);
  if (complete && text && !message.meta.querySelector("button")) {
    appendMessageCopyButton(message);
  }
  elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function autoSizePrompt() {
  elements.promptInput.style.height = "0px";
  elements.promptInput.style.height = `${Math.min(128, Math.max(24, elements.promptInput.scrollHeight))}px`;
}

function updateSendButtonLabel() {
  const kind = operationGate.kind;
  const label =
    kind === "api"
      ? "停止產生"
      : state.settings.mode === "chatgpt"
        ? "複製內容並開啟 ChatGPT"
        : "傳送給 API";
  elements.sendButton.setAttribute("aria-label", label);
}

function renderActivity() {
  const kind = operationGate.kind;
  const settingsBusy = Boolean(settingsMutations.kind);
  const active = Boolean(kind) || settingsBusy;
  const abortable = kind === "api";
  elements.appShell.setAttribute("aria-busy", String(active));
  elements.sendButton.classList.toggle("is-busy", abortable);
  elements.sendButton.disabled = settingsBusy || (Boolean(kind) && !abortable);
  elements.captureButton.disabled = active;
  elements.elementButton.disabled = active;
  elements.promptInput.disabled = active;
  elements.pageContextToggle.disabled = active;
  elements.selectionToggle.disabled = active;
  setElementInert(elements.attachmentStrip, active);
  document.querySelectorAll(".mode-tab, .quick-card").forEach((button) => {
    button.disabled = active;
  });
  elements.settingsButton.disabled = active;
  elements.openSettingsInline.disabled = active;
  elements.newChatButton.disabled = active;
  const settingsClosed = !elements.settingsSheet.classList.contains("is-open");
  if (settingsClosed) setElementInert(elements.settingsSheet, false);
  elements.settingsForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = settingsBusy;
  });
  setElementInert(elements.settingsSheet, settingsClosed);
  updateSendButtonLabel();
}

function beginOperation(kind) {
  if (settingsMutations.kind) return null;
  const operation = operationGate.begin(kind);
  if (!operation) return null;
  renderActivity();
  return operation;
}

function beginSettingsMutation(kind, settings) {
  if (operationGate.kind) return null;
  const mutation = settingsMutations.begin(kind, settings);
  if (!mutation) return null;
  renderActivity();
  return mutation;
}

function endSettingsMutation(mutation) {
  settingsMutations.end(mutation);
  renderActivity();
}

function endOperation(operation) {
  operationGate.end(operation);
  renderActivity();
}

async function refreshContext({ signal } = {}) {
  renderContextState("checking");
  try {
    const response = await requestContent("REQUEST_CONTEXT", {}, { signal });
    state.page = response.page ?? null;
    state.selection = String(response.selection ?? "");
    state.contextAvailable = Boolean(state.page);
    contextFreshness.markFresh(response.contextRevision);
    renderSelection();
    renderPageToggle();
    renderContextState(
      !contextFreshness.isFresh
        ? "stale"
        : state.contextAvailable
          ? "ready"
          : "unavailable",
    );
    return contextFreshness.isFresh;
  } catch (error) {
    if (error?.name === "AbortError") {
      renderContextState(
        !contextFreshness.isFresh
          ? "stale"
          : state.contextAvailable
            ? "ready"
            : "unavailable",
      );
      throw error;
    }
    state.page = null;
    state.selection = "";
    state.contextAvailable = false;
    contextFreshness.invalidate();
    renderSelection();
    renderPageToggle();
    renderContextState("unavailable");
    return false;
  }
}

async function captureViewport() {
  const operation = beginOperation("capture");
  if (!operation) return;
  try {
    const response = await requestContent("CAPTURE_VIEWPORT");
    if (
      operationGate.isCurrent(operation) &&
      addAttachment({ kind: "viewport", dataUrl: response.dataUrl })
    ) {
      showToast("已附上目前可見畫面");
    }
  } catch (error) {
    if (operationGate.isCurrent(operation)) {
      showToast(error.message || "無法擷取畫面", "error");
    }
  } finally {
    endOperation(operation);
  }
}

async function captureElement() {
  const operation = beginOperation("element-picker");
  if (!operation) return;
  showToast("請移到網頁上，按一下要擷取的元素");
  try {
    const response = await requestContent("PICK_ELEMENT");
    if (
      operationGate.isCurrent(operation) &&
      !response.cancelled &&
      addAttachment({
        kind: "element",
        dataUrl: response.dataUrl,
        metadata: response.metadata,
      })
    ) {
      showToast(`已附上 ${response.metadata?.element || "網頁元素"}`);
    }
  } catch (error) {
    if (operationGate.isCurrent(operation)) {
      showToast(error.message || "無法擷取元素", "error");
    }
  } finally {
    endOperation(operation);
  }
}

function buildCurrentPayload(prompt) {
  return buildContextPayload({
    prompt,
    page: state.page,
    selection: state.selection,
    element: latestElementMetadata(),
    includePage: state.settings.includePage,
    includeSelection: state.settings.includeSelection,
    includeElement: true,
  });
}

function legacyCopyText(text) {
  const activeElement = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  Object.assign(textarea.style, { position: "fixed", opacity: "0", pointerEvents: "none" });
  document.body.append(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
  }
}

async function copyText(text) {
  let modernCopy;
  try {
    modernCopy = navigator.clipboard?.writeText?.(text);
  } catch {
    modernCopy = undefined;
  }
  const legacyCopied = legacyCopyText(text);
  if (!modernCopy) return legacyCopied;
  try {
    await modernCopy;
    return true;
  } catch {
    return legacyCopied;
  }
}

async function copyAttachmentImage(attachment) {
  try {
    const blob = dataUrlToBlob(attachment.dataUrl);
    if (!globalThis.ClipboardItem || !navigator.clipboard?.write || blob.type !== "image/png") {
      throw new Error("Safari 無法直接複製這張圖片");
    }
    const write = navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    await write;
    showToast("圖片已複製，可貼到 ChatGPT");
  } catch {
    const link = document.createElement("a");
    link.href = attachment.dataUrl;
    link.download = `safai-${attachment.kind}-${Date.now()}.png`;
    link.click();
    showToast("無法直接複製，已改為下載圖片");
  }
}

async function openChatGptWithHandoff(prompt, operation, copiedPromise, attachmentCount) {
  const copied = await copiedPromise;
  if (!operationGate.isCurrent(operation)) return;

  if (!demoMode) {
    const response = await browserApi.runtime.sendMessage({ type: "OPEN_CHATGPT" });
    if (!response?.ok) throw new Error(response?.error || "無法開啟 ChatGPT");
  }
  if (!operationGate.isCurrent(operation)) return;
  addMessage("user", prompt, { labels: contextLabels() });

  const note = copied
    ? attachmentCount
      ? "內容已複製並開啟 ChatGPT。文字可直接貼上；截圖請點附件預覽後使用「複製圖片」。"
      : "內容已複製並開啟 ChatGPT，直接貼上即可開始對話。"
    : "ChatGPT 已開啟，但瀏覽器拒絕剪貼簿存取；請手動複製輸入內容。";
  addMessage("assistant", note);
  if (elements.liveStatus) elements.liveStatus.textContent = "ChatGPT 轉交內容已準備完成";
  elements.promptInput.value = "";
  autoSizePrompt();
  updateProviderStatus();
}

async function demoAssistant(onDelta, operation) {
  const parts = [
    "這是一段本機預覽回覆。",
    " SafAI 會把頁面、反白文字與圖片分成明確欄位，",
    "只有在你按下傳送後才交給指定的 API。",
  ];
  let output = "";
  for (const part of parts) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (!operationGate.isCurrent(operation) || state.abortController?.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    output += part;
    onDelta(part);
  }
  return output;
}

async function sendToApi(prompt, operation) {
  const payload = buildCurrentPayload(prompt);
  const sentAttachments = [...state.attachments];
  const sentAttachmentIds = new Set(sentAttachments.map((attachment) => attachment.id));
  const userContent = buildUserContent({ payload, attachments: sentAttachments });
  const messages = buildConversationMessages({
    history: state.history.slice(-12),
    userContent,
  });
  addMessage("user", prompt, { labels: contextLabels() });
  const assistantMessage = addMessage("assistant", "", { pending: true });
  let streamedText = "";
  const controller = state.abortController;

  try {
    const onDelta = (delta) => {
      if (!operationGate.isCurrent(operation)) return;
      streamedText += delta;
      updateAssistantMessage(assistantMessage, streamedText);
    };
    const answer = demoMode
      ? await demoAssistant(onDelta, operation)
      : await requestChatCompletion(
          {
            baseUrl: state.settings.baseUrl,
            apiKey: state.settings.apiKey,
            model: state.settings.model,
            messages,
            stream: state.settings.stream,
            signal: controller.signal,
          },
          onDelta,
        );
    if (!operationGate.isCurrent(operation)) return;
    const finalText = answer || streamedText || "API 沒有回傳文字內容。";
    updateAssistantMessage(assistantMessage, finalText, { complete: true });
    state.history.push(
      { role: "user", content: prompt },
      { role: "assistant", content: finalText },
    );
    state.history = state.history.slice(-12);
    state.attachments = state.attachments.filter(
      (attachment) => !sentAttachmentIds.has(attachment.id),
    );
    renderAttachments();
    elements.promptInput.value = "";
    autoSizePrompt();
    updateProviderStatus();
    if (elements.liveStatus) elements.liveStatus.textContent = "SafAI 回覆完成";
  } catch (error) {
    if (!operationGate.isCurrent(operation)) return;
    if (error?.name === "AbortError") {
      const stoppedText = streamedText || "已停止產生回覆。";
      updateAssistantMessage(
        assistantMessage,
        stoppedText,
        { complete: true },
      );
      state.history.push(
        { role: "user", content: prompt },
        { role: "assistant", content: stoppedText },
      );
      state.history = state.history.slice(-12);
      if (elements.liveStatus) elements.liveStatus.textContent = "已停止產生回覆";
    } else {
      updateAssistantMessage(
        assistantMessage,
        error?.message || "無法連線到 API",
        { error: true, complete: true },
      );
      throw error;
    }
  }
}

async function submitPrompt(event) {
  event.preventDefault();
  if (settingsMutations.kind) {
    showToast("請等待設定儲存完成", "error");
    return;
  }
  if (operationGate.kind) {
    if (operationGate.kind === "api") state.abortController?.abort();
    else showToast("請先完成目前操作", "error");
    return;
  }

  const typed = elements.promptInput.value.trim();
  const prompt = typed || (state.attachments.length ? "請分析附上的內容。" : "");
  if (!prompt) {
    showToast("請輸入問題，或先附上一張截圖", "error");
    elements.promptInput.focus();
    return;
  }

  const mode = state.settings.mode;
  if (mode === "chatgpt" && state.settings.includePage && !contextFreshness.isFresh) {
    const refreshOperation = beginOperation("context-refresh");
    if (!refreshOperation) return;
    try {
      const refreshed = await refreshContext();
      if (!operationGate.isCurrent(refreshOperation)) return;
      showToast(
        refreshed
          ? "頁面內容已更新，請再按一次以複製並開啟 ChatGPT"
          : "無法更新頁面內容；請重試或關閉「頁面」",
        refreshed ? "info" : "error",
      );
    } finally {
      endOperation(refreshOperation);
    }
    return;
  }
  const operation = beginOperation(mode === "api" ? "api" : "chatgpt");
  if (!operation) return;
  if (mode === "api") state.abortController = new AbortController();
  const attachmentCount = state.attachments.length;
  const chatGptCopy = mode === "chatgpt"
    ? copyText(buildChatGptHandoff({
        payload: buildCurrentPayload(prompt),
        attachmentCount,
      }))
    : null;

  try {
    if (mode === "api") {
      assertEndpointSecurity(state.settings.baseUrl, state.settings.apiKey);
      if (!state.settings.model.trim()) throw new Error("請先設定模型名稱");
      const permissionPromise = requestEndpointPermission(
        demoMode ? undefined : browserApi,
        state.settings.baseUrl,
      );
      const allowed = await permissionPromise;
      if (!allowed) throw new Error("需要允許連線到你設定的 API 網域");
      if (!operationGate.isCurrent(operation) || state.abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }
    if (mode === "api") {
      await refreshContext({ signal: state.abortController.signal });
    }
    if (!operationGate.isCurrent(operation)) return;
    if (mode === "chatgpt") {
      await openChatGptWithHandoff(prompt, operation, chatGptCopy, attachmentCount);
    } else {
      await sendToApi(prompt, operation);
    }
  } catch (error) {
    if (operationGate.isCurrent(operation) && error?.name !== "AbortError") {
      showToast(error?.message || "傳送失敗", "error");
    }
  } finally {
    if (operationGate.isCurrent(operation)) {
      state.abortController = null;
      endOperation(operation);
    }
  }
}

function setBackgroundInert(inert) {
  for (const region of [
    elements.topbar,
    elements.chatgptBanner,
    elements.conversation,
    elements.composerDock,
  ]) {
    setElementInert(region, inert);
  }
}

function focusableElements(container) {
  return Array.from(
    container.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function trapModalFocus(event, container) {
  if (event.key !== "Tab") return;
  const focusable = focusableElements(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openSettings() {
  if (operationGate.kind || settingsMutations.kind) {
    showToast("請先完成或停止目前操作", "error");
    return;
  }
  modalTrigger = document.activeElement;
  elements.baseUrlInput.value = state.settings.baseUrl;
  elements.apiKeyInput.value = state.settings.apiKey;
  elements.modelInput.value = state.settings.model;
  elements.streamInput.checked = state.settings.stream;
  setElementInert(elements.settingsSheet, false);
  elements.settingsSheet.classList.add("is-open");
  elements.settingsSheet.setAttribute("aria-hidden", "false");
  elements.sheetScrim.hidden = false;
  setBackgroundInert(true);
  setTimeout(() => elements.baseUrlInput.focus(), 160);
}

function closeSettings() {
  elements.settingsSheet.classList.remove("is-open");
  elements.settingsSheet.setAttribute("aria-hidden", "true");
  setElementInert(elements.settingsSheet, true);
  elements.sheetScrim.hidden = true;
  setBackgroundInert(false);
  modalTrigger?.focus?.();
  modalTrigger = undefined;
}

async function saveSettings(event) {
  event.preventDefault();
  if (operationGate.kind || settingsMutations.kind) {
    showToast("請先完成或停止目前操作", "error");
    return;
  }
  let next;
  const previous = state.settings;
  try {
    next = mergeSettings({
      ...state.settings,
      baseUrl: elements.baseUrlInput.value.trim(),
      apiKey: elements.apiKeyInput.value.trim(),
      model: elements.modelInput.value.trim(),
      stream: elements.streamInput.checked,
    });
    assertEndpointSecurity(next.baseUrl, next.apiKey);
    if (!next.model) throw new Error("模型名稱不可留空");
  } catch (error) {
    showToast(error?.message || "無法儲存設定", "error");
    return;
  }

  let oldPattern = "";
  try {
    oldPattern = endpointOriginPattern(previous.baseUrl);
  } catch {
    // A malformed legacy setting should not prevent saving a valid replacement.
  }
  const newPattern = endpointOriginPattern(next.baseUrl);
  const originChanged = oldPattern !== newPattern;
  const providerChanged = providerConfigurationChanged(previous, next);
  const mutation = beginSettingsMutation("save", next);
  if (!mutation) return;
  let cleanupWarning = false;
  let newlyGrantedPermission = false;

  try {
    const permissionPromise = requestEndpointPermissionWithPriorState(
      demoMode ? undefined : browserApi,
      next.baseUrl,
    );
    const { allowed, wasPresent } = await permissionPromise;
    newlyGrantedPermission = allowed && wasPresent === false;
    if (!allowed) throw new Error("未允許 SafAI 連線到這個 API 網域");
    if (!settingsMutations.isCurrent(mutation)) return;
    await persistSettings(next);
    if (!settingsMutations.isCurrent(mutation)) return;
    state.settings = next;
    renderMode();
    renderPageToggle();
    renderSelection();
    if (providerChanged) {
      resetConversationState({ clearDraft: false, clearAttachments: true });
    }
    if (originChanged && !demoMode && oldPattern) {
      try {
        const hadOldPermission = browserApi.permissions?.contains
          ? await browserApi.permissions.contains({ origins: [oldPattern] })
          : true;
        if (hadOldPermission) {
          const removed = await removeEndpointPermission(browserApi, previous.baseUrl);
          cleanupWarning = !removed;
        }
      } catch {
        cleanupWarning = true;
      }
    }
    closeSettings();
    showToast(
      cleanupWarning
        ? "設定已儲存；舊 API 網域權限請在 Safari 設定中移除"
        : "API 設定已儲存",
      cleanupWarning ? "error" : "info",
    );
  } catch (error) {
    if (settingsMutations.isCurrent(mutation)) {
      let permissionCleanupFailed = false;
      if (newlyGrantedPermission && !demoMode) {
        try {
          permissionCleanupFailed = !(await removeEndpointPermission(browserApi, next.baseUrl));
        } catch {
          permissionCleanupFailed = true;
        }
      }
      showToast(
        permissionCleanupFailed
          ? `${error?.message || "無法儲存設定"}；新網域權限請在 Safari 設定中移除`
          : error?.message || "無法儲存設定",
        "error",
      );
    }
  } finally {
    endSettingsMutation(mutation);
  }
}

function resetConversationState({ clearDraft = true, clearAttachments: removeAttachments = true } = {}) {
  state.history = [];
  if (removeAttachments) clearAttachments();
  elements.messageList.replaceChildren();
  elements.emptyState.hidden = false;
  if (clearDraft) {
    elements.promptInput.value = "";
    autoSizePrompt();
  }
}

function newConversation() {
  if (operationGate.kind || settingsMutations.kind) {
    showToast("請先完成或停止目前操作", "error");
    return;
  }
  operationGate.invalidate();
  state.abortController?.abort();
  state.abortController = null;
  renderActivity();
  resetConversationState();
  showToast("已開始新對話");
}

async function toggleSetting(key, render, errorMessage) {
  if (operationGate.kind || settingsMutations.kind) return;
  const previous = state.settings;
  const next = { ...previous, [key]: !previous[key] };
  const mutation = beginSettingsMutation("context", next);
  if (!mutation) return;
  state.settings = next;
  render();
  try {
    await persistSettings(next);
  } catch {
    if (settingsMutations.isCurrent(mutation)) {
      state.settings = previous;
      render();
      showToast(errorMessage, "error");
    }
  } finally {
    endSettingsMutation(mutation);
  }
}

function openPreview(attachmentId) {
  const attachment = state.attachments.find((item) => item.id === attachmentId);
  if (!attachment) return;
  modalTrigger = document.activeElement;
  state.previewAttachmentId = attachment.id;
  elements.previewImage.src = attachment.dataUrl;
  elements.previewTitle.textContent = attachmentName(attachment);
  elements.previewOverlay.hidden = false;
  setBackgroundInert(true);
  elements.copyPreviewButton.focus();
}

function closePreview() {
  state.previewAttachmentId = null;
  elements.previewOverlay.hidden = true;
  elements.previewImage.removeAttribute("src");
  setBackgroundInert(false);
  modalTrigger?.focus?.();
  modalTrigger = undefined;
}

function bindEvents() {
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => applyMode(button.dataset.mode));
    button.addEventListener("keydown", (event) => {
      const tabs = Array.from(document.querySelectorAll(".mode-tab"));
      let index = tabs.indexOf(button);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") index += 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") index -= 1;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else return;
      event.preventDefault();
      const next = tabs[(index + tabs.length) % tabs.length];
      next.focus();
      applyMode(next.dataset.mode);
    });
  });
  document.querySelectorAll(".quick-card").forEach((button) => {
    button.addEventListener("click", () => {
      elements.promptInput.value = button.dataset.prompt || "";
      autoSizePrompt();
      elements.promptInput.focus();
    });
  });

  elements.promptInput.addEventListener("input", autoSizePrompt);
  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });
  elements.composerForm.addEventListener("submit", submitPrompt);
  elements.captureButton.addEventListener("click", captureViewport);
  elements.elementButton.addEventListener("click", captureElement);
  elements.pageContextToggle.addEventListener("click", () =>
    toggleSetting("includePage", renderPageToggle, "無法儲存頁面設定"),
  );
  elements.selectionToggle.addEventListener("click", () =>
    toggleSetting("includeSelection", renderSelection, "無法儲存反白設定"),
  );

  elements.attachmentStrip.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "remove") {
      state.attachments = state.attachments.filter((item) => item.id !== button.dataset.id);
      renderAttachments();
    } else if (button.dataset.action === "preview") {
      openPreview(button.dataset.id);
    }
  });

  elements.settingsButton.addEventListener("click", openSettings);
  elements.openSettingsInline.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.sheetScrim.addEventListener("click", closeSettings);
  elements.settingsForm.addEventListener("submit", saveSettings);
  elements.revealKeyButton.addEventListener("click", () => {
    const revealing = elements.apiKeyInput.type === "password";
    elements.apiKeyInput.type = revealing ? "text" : "password";
    elements.revealKeyButton.setAttribute("aria-label", revealing ? "隱藏 API Key" : "顯示 API Key");
  });
  elements.newChatButton.addEventListener("click", newConversation);
  elements.closeButton.addEventListener("click", () => {
    operationGate.invalidate();
    state.abortController?.abort();
    state.abortController = null;
    renderActivity();
    requestContent("CANCEL_PICKER").catch(() => {});
    requestContent("CLOSE_PANEL").catch(() => {});
  });
  elements.closePreviewButton.addEventListener("click", closePreview);
  elements.copyPreviewButton.addEventListener("click", () => {
    const attachment = state.attachments.find((item) => item.id === state.previewAttachmentId);
    if (attachment) copyAttachmentImage(attachment);
  });
  document.addEventListener("keydown", (event) => {
    if (operationGate.kind === "element-picker") {
      if (event.key === "Escape") {
        event.preventDefault();
        requestContent("CANCEL_PICKER").catch(() => {});
      } else if (event.key === "Tab") {
        event.preventDefault();
        requestContent("PICKER_NAVIGATE", {
          direction: event.shiftKey ? -1 : 1,
        }).catch(() => {});
      } else if (event.key === "Enter") {
        event.preventDefault();
        requestContent("PICKER_CONFIRM").catch(() => {});
      }
      return;
    }
    if (!elements.previewOverlay.hidden) {
      trapModalFocus(event, elements.previewOverlay);
      if (event.key === "Escape") closePreview();
      return;
    }
    if (elements.settingsSheet.classList.contains("is-open")) {
      trapModalFocus(event, elements.settingsSheet);
      if (event.key === "Escape") closeSettings();
    }
  });
}

async function initialize() {
  setElementInert(elements.settingsSheet, true);
  bindEvents();
  state.settings = await loadSettings();
  await applyMode(state.settings.mode, { save: false });
  renderPageToggle();
  renderSelection();
  renderAttachments();
  autoSizePrompt();
  renderContextState("checking");
  await refreshContext();
  if (demoMode) document.documentElement.dataset.demo = "true";
}

initialize().catch((error) => showToast(error?.message || "SafAI 無法啟動", "error"));
