import {
  buildConversationMessages,
  normalizeConversationStore,
  upsertConversation,
} from "../core/conversation.js";
import { isValidBridgeConnectEvent, readBridgeToken } from "../core/bridge.js";
import { dataUrlToBlob } from "../core/data-url.js";
import { ContextFreshness } from "../core/context-freshness.js";
import { renderMessageMarkdown } from "../core/message-renderer.js";
import { OperationGate } from "../core/operation-gate.js";
import { createInertController } from "./inert-controller.js";
import { createMessageSanitizer } from "./rich-text-dom.js";
import { createReadingFeatures } from "./reading-features.js";
import { installAppleControls } from "./apple-controls.js";
import { createRelayPanel } from "./relay-panel.js";
import { sendNativeRelayCommand } from "./native-relay-client.js";
import { t, setLanguage, getLanguage, createDocumentLocalizer } from "../i18n/index.js";
import { sourcesForPage } from "../core/citations.js";
import { collectAnnotations } from "../core/annotations.js";
import { estimateRequestTokens, requestInputBudget, pageTokenBudget } from "../core/request-budget.js";
import {
  assertEndpointSecurity,
  requestChatCompletion,
} from "../core/openai.js";
import {
  endpointOriginPattern,
  requestEndpointPermissionWithPriorState,
} from "../core/permissions.js";
import {
  boundedImageAttachments,
  buildContextPayload,
  buildPromptText,
  buildUserContent,
} from "../core/prompt.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  providerConfigurationChanged,
  SettingsMutationCoordinator,
} from "../core/settings.js";

const browserApi = globalThis.browser ?? globalThis.chrome;
const demoMode = new URLSearchParams(location.search).has("demo");
document.documentElement.dataset.embedded = String(window.parent !== window);
setLanguage("auto");
const localizeDocument = createDocumentLocalizer(document);
localizeDocument();
const CONVERSATION_STORE_KEY = "conversations";

const byId = (id) => document.getElementById(id);
const elements = {
  appShell: byId("appShell"),
  topbar: document.querySelector(".topbar"),
  conversation: byId("conversation"),
  emptyState: byId("emptyState"),
  messageList: byId("messageList"),
  historyButton: byId("historyButton"),
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
  validateKeyButton: byId("validateKeyButton"),
  validationStatus: byId("validationStatus"),
  baseUrlInput: byId("baseUrlInput"),
  apiKeyInput: byId("apiKeyInput"),
  modelInput: byId("modelInput"),
  languageInput: byId("languageInput"),
  contextWindowInput: byId("contextWindowInput"),
  doubleContextWindowButton: byId("doubleContextWindowButton"),
  halveContextWindowButton: byId("halveContextWindowButton"),
  streamInput: byId("streamInput"),
  revealKeyButton: byId("revealKeyButton"),
  previewOverlay: byId("previewOverlay"),
  previewImage: byId("previewImage"),
  previewTitle: byId("previewTitle"),
  closePreviewButton: byId("closePreviewButton"),
  copyPreviewButton: byId("copyPreviewButton"),
  toast: byId("toast"),
  liveStatus: byId("liveStatus"),
  historyDrawer: byId("historyDrawer"),
  historyList: byId("historyList"),
  closeHistoryButton: byId("closeHistoryButton"),
  historySearch: byId("historySearch"),
  sidebarTitle: byId("sidebarTitle"),
  modelButton: byId("modelButton"),
  modelLabel: byId("modelLabel"),
  modeMenu: byId("modeMenu"),
  attachButton: byId("attachButton"),
  attachMenu: byId("attachMenu"),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  page: null,
  pageKey: null,
  selection: "",
  attachments: [],
  history: [],
  savedMessageCount: 0,
  conversations: [],
  pageSelections: {},
  activeConversationId: createConversationId(),
  contextAvailable: false,
  abortController: null,
  previewAttachmentId: null,
  comparedPages: [],
  quickSelection: "",
  retainedSelections: [],
  annotationPageUrl: null,
  annotationPageIdentity: null,
  ignoredSelection: "",
  preparedReading: null,
  handoffReading: null,
};

const operationGate = new OperationGate();
const settingsMutations = new SettingsMutationCoordinator();
const contextFreshness = new ContextFreshness();
const setElementInert = createInertController(window);
const sanitizeMessageHtml = createMessageSanitizer(window);
const pendingBridgeRequests = new Map();
const localizedTexts = new WeakMap();

function setLocalizedText(element, source, values = []) {
  localizedTexts.set(element, { source, values });
  element.textContent = t(source, values);
}
const expectedBridgeToken = readBridgeToken(location.href);
let bridgePort;
let resolveBridgeReady;
const bridgeReady = new Promise((resolve) => {
  resolveBridgeReady = resolve;
});
let requestSequence = 0;
let toastTimer;
let modalTrigger;
let historyTrigger;
let activePopover;
let settingsFormSnapshot;
let settingsValidationController;
let savedReadSequence = 0;
let contextReadSequence = 0;
let readingFeatures;
let relayPanel;

function longReadingNeeded() {
  if (!state.comparedPages.length && !needsPageContext()) return false;
  return state.comparedPages.length ? state.comparedPages.some(page => page.truncated) : state.page?.truncated === true;
}

function readingFingerprint(prompt) {
  return JSON.stringify({ prompt, contextWindowTokens: state.settings.contextWindowTokens, page: state.page?.identity ?? state.page?.url, annotations: hasAnnotations() ? selectedPassages() : [], tabs: state.comparedPages.map(page => [page.tabId, page.url]), includePage: state.settings.includePage, includeSelection: state.settings.includeSelection });
}

function setLongStatus(text) {
  byId("longProgress").textContent = text;
  byId("longProgress").hidden = !text;
}

async function releaseReadingPlans(plan) {
  if (!plan?.plans) return;
  await Promise.all(plan.plans.map(async page => {
    try {
      if (Number.isInteger(page.tabId)) await readingRequest("RELEASE_LONG_TAB", { tabId: page.tabId, url: page.url, snapshotId: page.snapshotId });
      else await requestContent("RELEASE_LONG_CONTEXT", { snapshotId: page.snapshotId });
    } catch { /* A closed/revoked page cannot be reached; never reauthorize it for cleanup. */ }
  }));
}

function invalidateLongPreparation() {
  if (operationGate.kind) return;
  state.preparedReading = null;
  state.handoffReading = null;
  setLongStatus("");
}

function currentRequestMessages(prompt, settings, withoutPages = false) {
  const payload = withoutPages ? buildContextPayload({ prompt,
    annotations: hasAnnotations(settings) ? selectedPassages() : [],
    includeSelection: settings.includeSelection, element: latestElementMetadata(),
  }) : buildCurrentPayload(prompt, settings);
  return buildConversationMessages({ history: state.history.slice(-12),
    userContent: buildUserContent({ payload, attachments: state.attachments }),
  });
}

async function prepareReadingPlans(prompt, settings, signal, overrideBudget) {
  setLongStatus(t("正在準備頁面內容並估算請求容量…"));
  const annotations = hasAnnotations(settings) ? selectedPassages() : [];
  const fingerprint = readingFingerprint(prompt);
  const budgetTokens = settings.mode === "api" ? overrideBudget ?? pageTokenBudget(settings,
    currentRequestMessages(prompt, settings, true), Math.max(1, state.comparedPages.length)) : undefined;
  const centered = settings.mode === "api" ? { strategy: "centered", budgetTokens, anchorSelection: state.selection } : {};
  let plans;
  if (state.comparedPages.length) {
    plans = (await readingRequest("PREPARE_LONG_TABS", { items: state.comparedPages.map(page => ({ id: page.tabId, url: page.url })), query: prompt, ...centered })).plans;
  } else {
    plans = [(await requestContent("PREPARE_LONG_CONTEXT", { query: prompt, annotations, ...centered }, { signal })).plan];
  }
  if (!Array.isArray(plans) || !plans.length || plans.some(plan => !plan?.snapshotId || !plan.context?.sources?.length)) throw new Error(t("長文上下文準備失敗，未傳送內容"));
  if (settings.mode !== "api" && plans.some(plan => plan.context.coverage?.missingAnnotations || plan.context.coverage?.ambiguousAnnotations)) {
    await releaseReadingPlans({ plans });
    throw new Error(t("部分標註找不到唯一原文位置，無法確認前後文；請重新選取或移除該段後再傳送"));
  }
  return { plans, prompt, settings: { ...settings }, annotations: [...annotations], compared: state.comparedPages.length > 0, fingerprint, budgetTokens };
}

async function validateReadingPlan(plan, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return Number.isInteger(plan.tabId)
    ? readingRequest("VALIDATE_LONG_TAB", { tabId: plan.tabId, url: plan.url, snapshotId: plan.snapshotId })
    : requestContent("VALIDATE_LONG_CONTEXT", { snapshotId: plan.snapshotId }, { signal });
}

function relevantReading(plan) {
  const pages = plan.plans.map(page => ({ title: page.title, url: page.url, sources: page.context.sources, coverage: page.context.coverage, outline: page.context.outline, originalChars: page.totalChars, truncated: !page.context.coverage.complete }));
  const citationSources = plan.plans.flatMap(page => page.context.sources.map(source => ({ ...source, ...(Number.isInteger(page.tabId) ? { tabId: page.tabId } : {}) })));
  const selected = pages.reduce((sum, page) => sum + page.coverage.selectedChars, 0);
  const total = plan.plans.reduce((sum, page) => sum + page.totalChars, 0);
  setLongStatus(selected < total
    ? t("受容量限制，本次附上 {0} / {1} 字元；優先保留反白或可見區域附近內容（token 用量為估算）。", [selected.toLocaleString(getLanguage()), total.toLocaleString(getLanguage())])
    : t("本次附上完整可讀正文，共 {0} 字元。", [total.toLocaleString(getLanguage())]));
  return { pages, citationSources, annotations: plan.annotations, compared: plan.compared };
}

function hasAnnotations(settings = state.settings) {
  return !state.comparedPages.length && settings.includeSelection && Boolean(state.retainedSelections.length || state.selection.trim());
}

function needsPageContext(settings = state.settings) {
  // includePage remains in the stored schema for migration/CAS compatibility only.
  return !state.comparedPages.length;
}

function selectedPassages() {
  const passages = collectAnnotations(state.retainedSelections, state.selection);
  if (passages.length && state.annotationPageUrl && state.page?.url !== state.annotationPageUrl) {
    throw new Error(t("這些標註屬於先前的頁面，請回到來源頁面或移除舊標註後再傳送"));
  }
  if (passages.length && state.annotationPageIdentity && state.page?.identity !== state.annotationPageIdentity) {
    throw new Error(t("頁面已換成其他內容；請回到標註的來源頁面，或移除舊標註後重新選取"));
  }
  return passages;
}

async function retainSelection() {
  if (operationGate.kind || settingsMutations.kind || !state.selection.trim()) return;
  try {
    invalidateLongPreparation();
    if (!state.page?.url) throw new Error(t("請等頁面上下文讀取完成後再保留標註"));
    const passages = selectedPassages();
    state.retainedSelections = passages;
    state.annotationPageUrl = state.page.url;
    state.annotationPageIdentity = state.page.identity ?? null;
    state.ignoredSelection = state.selection;
    state.selection = state.quickSelection = "";
    renderSelection();
    await requestContent("CLEAR_SELECTION");
    showToast(t("已保留標註，現在可以回到網頁反白下一段"));
  } catch (error) { showToast(error.message, "error"); }
}

async function readingRequest(type, payload = {}) {
  if (demoMode) {
    if (type === "LIST_READING_TABS") return { tabs: [{ id: 1, title: t("範例：閱讀方法"), url: "https://example.com/reading" }, { id: 2, title: t("範例：筆記方法"), url: "https://example.com/notes" }] };
    if (type === "READ_READING_TABS") return { pages: payload.items.map(item => ({ tabId: item.id, url: item.url, title: t("範例分頁 {0}", [item.id]), text: t("這是本機展示資料，不是即時讀取的網頁。閱讀時先理解核心概念，再整理筆記。") })) };
    return { ok: true };
  }
  let timer;
  try {
    const response = await Promise.race([
      browserApi.runtime.sendMessage({ type, ...payload }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(t("分頁讀取逾時，請重新整理目前頁面後再試"))), 15000); }),
    ]);
    if (!response?.ok) throw new Error(response?.error || t("無法讀取分頁"));
    return response;
  } finally { clearTimeout(timer); }
}

function insertPrompt(prompt) {
  if (operationGate.kind || settingsMutations.kind) { showToast(t("請先完成或停止目前操作"), "error"); return; }
  invalidateLongPreparation();
  const previous = elements.promptInput.value.trim();
  const next = previous ? `${previous}\n\n${prompt}` : prompt;
  if (next.length > 8000) { showToast(t("草稿過長，請先縮短後再加入指令"), "error"); return; }
  elements.promptInput.value = next;
  autoSizePrompt();
  elements.promptInput.focus();
}

function renderComparedPages() {
  const list = byId("comparedPages");
  list.replaceChildren();
  list.hidden = !state.comparedPages.length;
  state.comparedPages.forEach(page => {
    const row = document.createElement("details"); row.className = "compared-page";
    const name = document.createElement("summary"); name.textContent = page.title || page.url;
    const text = document.createElement("pre"); text.textContent = `${page.url}\n\n${page.text}`;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "reading-button";
    remove.textContent = t("移除此分頁");
    remove.addEventListener("click", () => {
      if (operationGate.kind) return;
      invalidateLongPreparation();
      state.comparedPages = state.comparedPages.filter(item => item.tabId !== page.tabId);
      renderComparedPages(); renderPageToggle(); renderSelection();
    });
    row.append(name, text, remove); list.append(row);
  });
}

function promptSources(settings = state.settings) {
  if (state.preparedReading) return state.preparedReading.citationSources;
  if (state.comparedPages.length) return state.comparedPages.flatMap((page, index) =>
    sourcesForPage(page, { prefix: `T${index + 1}P`, maxSources: 14 }).map(source => ({ ...source, tabId: page.tabId })));
  return needsPageContext(settings) && state.page ? sourcesForPage(state.page) : [];
}

function appendCitations(message, sources) {
  const referenced = sources.filter(source => message.rawText.includes(`[${source.id}]`));
  if (!referenced.length) return;
  const list = document.createElement("div"); list.className = "citation-list"; list.setAttribute("aria-label", t("回答引用來源"));
  for (const source of referenced) {
    const button = document.createElement("button"); button.type = "button"; button.className = "citation-button";
    setLocalizedText(button, "[{0}] 原文", [source.id]);
    button.title = `${source.title}\n${source.quote.slice(0, 160)}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (Number.isInteger(source.tabId)) await readingRequest("LOCATE_TAB_SOURCE", source);
        else await requestContent("LOCATE_SOURCE", { quote: source.quote, url: source.url });
        showToast(t("已標亮原文"));
      } catch (error) { showToast(error.message, "error"); }
      finally { button.disabled = false; }
    });
    list.append(button);
  }
  message.bubble.append(list);
}

function createConversationId() {
  return crypto.randomUUID();
}

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
    <text x="120" y="180" fill="${accent}" font-family="Avenir Next, sans-serif" font-size="28" letter-spacing="5">MARGINA PREVIEW</text>
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
      pageKey: "demo:editorial-interface",
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
  if (message.type === "QUICK_ASK") {
    if (operationGate.kind || settingsMutations.kind) { showToast(t("請先完成目前操作，再選取文字"), "error"); return; }
    if (typeof message.selection !== "string" || typeof message.prompt !== "string") return;
    invalidateLongPreparation();
    state.comparedPages = [];
    renderComparedPages();
    renderPageToggle();
    state.quickSelection = state.selection = message.selection.slice(0, 16000);
    state.ignoredSelection = "";
    if (!state.retainedSelections.length) {
      state.annotationPageUrl = state.page?.url ?? null;
      state.annotationPageIdentity = state.page?.identity ?? null;
    }
    closeConversationHistory({ restoreFocus: false });
    renderSelection();
    insertPrompt(message.prompt.slice(0, 2000));
    showToast(state.settings.includeSelection ? t("已帶入反白文字，按傳送才交給 AI") : t("反白內容目前不會附上；請先開啟反白開關"));
    return;
  }
  if (message.type === "PAGE_CONTEXT_INVALIDATED") {
    invalidateLongPreparation();
    contextFreshness.invalidate(message.contextRevision);
    if (!contextFreshness.isFresh) {
      renderPageToggle();
    }
    if (message.pageChanged) {
      contextReadSequence++;
      state.abortController?.abort();
      state.abortController = null;
      operationGate.invalidate();
      resetConversationState();
      state.page = null;
      state.contextAvailable = false;
      renderActivity();
      refreshContext().catch(error => showToast(error.message, "error"));
    }
    return;
  }
  if (message.type === "SELECTION_CHANGED") {
    if (operationGate.kind === "api" || operationGate.kind === "chatgpt") return;
    invalidateLongPreparation();
    const selection = String(message.selection ?? "");
    if (!selection || selection !== state.ignoredSelection) {
      state.ignoredSelection = "";
      if (!state.quickSelection) state.selection = selection;
    }
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
  else pending.reject(new Error(message.error || t("操作失敗")));
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
      reject(new Error(t("安全連線未建立，請重新開啟 Margina")));
    }, 15_000);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(requestAbortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
    bridgeReady.then(finish);
  });
  if (signal?.aborted) throw requestAbortError(signal);

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
      reject(new Error(type === "PICK_ELEMENT" ? t("元素選取已逾時") : t("網頁沒有回應")));
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
  elements.toast.textContent = t(message);
  elements.toast.classList.toggle("is-error", type === "error");
  elements.toast.classList.add("is-visible");
  elements.toast.setAttribute("role", type === "error" ? "alert" : "status");
  if (type === "error") {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = t("關閉");
    dismiss.setAttribute("aria-label", t("關閉錯誤訊息"));
    dismiss.addEventListener("click", () => elements.toast.classList.remove("is-visible"));
    elements.toast.append(dismiss);
  } else {
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2800);
  }
}

async function loadSettings() {
  if (demoMode) return { ...DEFAULT_SETTINGS };
  if (location.protocol === "safari-web-extension:") {
    return mergeSettings((await requestStorage("GET_SETTINGS", {})).settings);
  }
  const saved = await browserApi.storage.local.get("settings");
  return mergeSettings(saved.settings);
}

async function requestStorage(type, payload) {
  const response = await browserApi.runtime.sendMessage({ type, ...payload });
  if (response?.code === "SETTINGS_CONFLICT") await refreshSavedState();
  if (!response?.ok) throw new Error(response?.error || t("無法確認資料是否儲存，請重新開啟側欄檢查"));
  return response;
}

async function persistSettings(patch, expected = {}, verifyPermission = false) {
  if (demoMode) return { settings: mergeSettings({ ...state.settings, ...patch }) };
  return requestStorage("PATCH_SETTINGS", { patch, expected, verifyPermission });
}

async function loadConversationStore() {
  if (demoMode) return normalizeConversationStore();
  const saved = await browserApi.storage.local.get(CONVERSATION_STORE_KEY);
  return normalizeConversationStore(saved[CONVERSATION_STORE_KEY]);
}

async function persistConversationSelection() {
  if (demoMode) return;
  const response = await requestStorage("SELECT_CONVERSATION", {
    id: state.conversations.some((conversation) => conversation.id === state.activeConversationId) ? state.activeConversationId : null,
    pageKey: state.pageKey ?? undefined,
  });
  state.conversations = response.conversations.conversations;
  state.pageSelections = response.conversations.pageSelections;
  renderConversationHistory();
}

async function saveActiveConversation() {
  const added = state.history.slice(state.savedMessageCount);
  if (!added.length) return;
  const id = state.activeConversationId;
  const pageKey = state.pageKey;
  const messageCount = state.history.length;
  try {
    const store = demoMode ? upsertConversation(
      { activeConversationId: id, conversations: state.conversations, pageSelections: state.pageSelections },
      { id, pageKey: pageKey ?? undefined, updatedAt: Date.now(), messages: state.history },
    ) : (await requestStorage("APPEND_CONVERSATION", { id, pageKey: pageKey ?? undefined, messages: added })).conversations;
    state.conversations = store.conversations;
    state.pageSelections = store.pageSelections;
    if (state.activeConversationId === id && state.pageKey === pageKey) state.savedMessageCount = messageCount;
    renderConversationHistory();
  } catch {
    showToast(t("無法確認這次對話是否儲存；請保留此頁並檢查對話紀錄。"), "error");
  }
}

function updateProviderStatus() {
  elements.modelLabel.textContent = state.settings.mode === "chatgpt" ? "ChatGPT" : state.settings.model || t("選擇模型");
  const chatgpt = state.settings.mode === "chatgpt";
  elements.providerStatus.closest(".provider-line").hidden = !chatgpt;
  elements.providerStatus.textContent = chatgpt ? t("附到右側 ChatGPT 草稿，由你確認後送出") : "";
  elements.openSettingsInline.textContent = t("API 設定");
}

function renderMode() {
  document.querySelectorAll(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === state.settings.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const chatgpt = state.settings.mode === "chatgpt";
  elements.appShell.dataset.chatgpt = String(chatgpt);
  elements.chatgptBanner.hidden = !chatgpt || !elements.historyDrawer.hidden;
  elements.conversation.hidden = chatgpt || !elements.historyDrawer.hidden;
  relayPanel?.setActive(chatgpt && elements.historyDrawer.hidden);
  elements.promptInput.placeholder =
    state.settings.mode === "chatgpt"
      ? t("附上問題、標註或圖片到 ChatGPT…")
      : t("詢問目前頁面的任何事情…");
  updateSendButtonLabel();
  updateProviderStatus();
}

async function applyMode(mode, { save = true } = {}) {
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
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
  try {
    const saved = await persistSettings({ mode: nextMode }, { mode: previousMode });
    if (!settingsMutations.isCurrent(mutation)) return;
    state.settings = saved.settings;
    renderMode();
    if (await startNewConversation({ clearDraft: false, clearAttachments: false })) {
      showToast(t("已切換模式並開始新對話"));
    }
  } catch (error) {
    if (!settingsMutations.isCurrent(mutation)) return;
    renderMode();
    showToast(error.message, "error");
  } finally {
    endSettingsMutation(mutation);
  }
}

function renderPageToggle() {
  const comparing = state.comparedPages.length > 0;
  const enabled = needsPageContext();
  const coverage = byId("contextCoverage");
  const pages = comparing ? state.comparedPages : enabled && state.page ? [state.page] : [];
  coverage.textContent = pages.some(page => page.truncated)
    ? t("送出時依設定容量準備完整頁面內容。")
    : "";
  coverage.hidden = !coverage.textContent;
}

function renderSelection() {
  renderPageToggle();
  const hasSelection = Boolean(state.selection.trim() || state.retainedSelections.length);
  elements.selectionCard.hidden = !hasSelection || state.comparedPages.length > 0 || ["api", "chatgpt"].includes(operationGate.kind);
  if (!hasSelection) return;

  elements.selectionText.textContent = state.selection;
  byId("liveAnnotation").hidden = !state.selection.trim();
  const list = byId("savedAnnotations");
  list.replaceChildren();
  state.retainedSelections.forEach((text, index) => {
    const row = document.createElement("article"); row.className = "saved-annotation";
    const header = document.createElement("header");
    const name = document.createElement("span"); name.textContent = t("標註 {0}", [index + 1]);
    const remove = document.createElement("button"); remove.type = "button"; remove.textContent = t("移除"); remove.setAttribute("aria-label", t("移除標註 {0}", [index + 1]));
    remove.addEventListener("click", () => {
      if (operationGate.kind || settingsMutations.kind) return;
      invalidateLongPreparation();
      state.retainedSelections = state.retainedSelections.filter((_, i) => i !== index);
      if (!state.retainedSelections.length) { state.annotationPageUrl = null; state.annotationPageIdentity = null; }
      renderSelection();
    });
    const quote = document.createElement("blockquote"); quote.textContent = text;
    header.append(name, remove); row.append(header, quote); list.append(row);
  });
  byId("retainSelectionButton").disabled = !state.selection.trim() || Boolean(operationGate.kind) || Boolean(settingsMutations.kind);
  byId("annotationHint").textContent = state.retainedSelections.length && !state.selection.trim()
    ? t("已保留 {0} 段。請回到網頁反白下一段；傳送時附上頁面上下文與所有標註。", [state.retainedSelections.length])
    : t("按＋保留這段後，可繼續反白其他內容；目前反白也會一起傳送。");
  const included = state.settings.includeSelection;
  elements.selectionCard.classList.toggle("is-excluded", !included);
  elements.selectionToggle.classList.toggle("is-on", included);
  elements.selectionToggle.setAttribute("aria-pressed", String(included));
  elements.selectionToggle.querySelector("span").textContent = included ? t("會附上") : t("不附上");
}

function attachmentName(attachment) {
  if (attachment.kind === "element") return attachment.metadata?.element || t("網頁元素");
  return t("目前畫面");
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
    preview.setAttribute("aria-label", t("預覽{0}", [attachmentName(attachment)]));

    const label = document.createElement("span");
    label.className = "attachment-kind";
    label.textContent = attachment.kind === "element" ? t("元素") : t("畫面");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.dataset.action = "remove";
    remove.dataset.id = attachment.id;
    remove.setAttribute("aria-label", t("移除{0}", [attachmentName(attachment)]));
    remove.append(svgUse("close"));

    card.append(image, preview, label, remove);
    elements.attachmentStrip.append(card);
  }
}

function addAttachment(attachment) {
  if (state.attachments.length >= 4) {
    showToast(t("每次最多附上 4 張截圖"), "error");
    return false;
  }
  const candidate = {
    id: crypto.randomUUID(),
    ...attachment,
  };
  const bounded = boundedImageAttachments([...state.attachments, candidate]);
  if (!bounded.includes(candidate)) {
    showToast(t("截圖過大；請縮小視窗或改為框選較小的元素"), "error");
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

function contextLabels(settings = state.settings) {
  const labels = [];
  const label = (source, values = []) => labels.push({ source, values });
  if (state.preparedReading) label(state.preparedReading.pages.some(page => page.coverage?.strategy === "full-summary") ? "全文分批摘要" : "長文重點上下文");
  if (state.comparedPages.length) label("比較 {0} 個分頁", [state.comparedPages.length]);
  else if (needsPageContext(settings) && state.page) label("頁面上下文");
  if (hasAnnotations(settings)) label("{0} 段標註", [selectedPassages().length]);
  if (state.attachments.length) label("{0} 張截圖", [state.attachments.length]);
  return labels;
}

function renderMessageText(message, text, { rich = false } = {}) {
  message.rawText = String(text ?? "");
  message.content.replaceChildren();
  if (!rich || !message.rawText) {
    message.content.textContent = message.rawText;
    return;
  }
  message.content.append(sanitizeMessageHtml(renderMessageMarkdown(message.rawText)));
}

function appendMessageCopyButton(message) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "icon-button message-copy";
  copy.setAttribute("aria-label", t("複製回覆"));
  copy.append(svgUse("copy"));
  copy.addEventListener("click", async () => {
    const copied = await copyText(message.rawText);
    showToast(copied ? t("已複製回覆") : t("無法存取剪貼簿"), copied ? "info" : "error");
  });
  message.meta.append(copy);
}

function addMessage(role, text, { labels = [], error = false, pending = false, scroll = true } = {}) {
  elements.emptyState.hidden = true;
  const article = document.createElement("article");
  article.className = `message ${role}${error ? " is-error" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  setLocalizedText(name, role === "user" ? "你" : error ? "發生錯誤" : "Margina");
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
      setLocalizedText(badge, label.source, label.values);
      context.append(badge);
    }
    bubble.append(context);
  }

  article.append(meta, bubble);
  elements.messageList.append(article);
  if (scroll) elements.conversation.scrollTop = elements.conversation.scrollHeight;
  return message;
}

function formatConversationTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(getLanguage(), sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "numeric", day: "numeric" },
  ).format(date);
}

function renderConversationTranscript() {
  elements.messageList.replaceChildren();
  elements.emptyState.hidden = state.history.length > 0;
  for (const message of state.history) {
    addMessage(message.role, message.content, { scroll: false });
  }
  elements.conversation.scrollTop = state.history.length ? elements.conversation.scrollHeight : 0;
}

function renderConversationHistory() {
  elements.historyList.replaceChildren();
  const query = elements.historySearch.value.trim().toLocaleLowerCase();
  const conversations = state.conversations.filter(conversation =>
    (!conversation.pageKey || conversation.pageKey === state.pageKey) && conversation.title.toLocaleLowerCase().includes(query));
  if (!conversations.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = query ? t("沒有符合的對話") : t("完成一段對話後，會顯示在這裡。");
    elements.historyList.append(empty);
    return;
  }

  for (const conversation of conversations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.classList.toggle("is-active", conversation.id === state.activeConversationId);
    item.disabled = Boolean(operationGate.kind || settingsMutations.kind);
    item.setAttribute("aria-label", t("開啟對話：{0}", [conversation.title]));
    item.setAttribute("aria-current", conversation.id === state.activeConversationId ? "page" : "false");

    const title = document.createElement("strong");
    title.textContent = conversation.title;
    const time = document.createElement("time");
    time.dateTime = new Date(conversation.updatedAt).toISOString();
    time.textContent = formatConversationTimestamp(conversation.updatedAt);
    item.append(title, time);
    if (!conversation.pageKey) {
      const legacy = document.createElement("span");
      legacy.textContent = t("先前未分類的對話");
      item.append(legacy);
    }
    item.addEventListener("click", () => selectConversation(conversation.id));
    elements.historyList.append(item);
  }
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
      ? t("停止產生")
      : state.settings.mode === "chatgpt"
        ? t("附到 ChatGPT")
        : t("傳送給 API");
  elements.sendButton.setAttribute("aria-label", label);
}

function renderActivity() {
  renderSelection();
  const kind = operationGate.kind;
  const settingsBusy = Boolean(settingsMutations.kind);
  const active = Boolean(kind) || settingsBusy;
  if (active) closePopovers();
  const abortable = kind === "api";
  elements.appShell.setAttribute("aria-busy", String(active));
  elements.sendButton.classList.toggle("is-busy", abortable);
  elements.sendButton.disabled = settingsBusy || (Boolean(kind) && !abortable);
  elements.captureButton.disabled = active;
  elements.elementButton.disabled = active;
  elements.promptInput.disabled = active;
  elements.selectionToggle.disabled = active;
  byId("retainSelectionButton").disabled = active || !state.selection.trim();
  setElementInert(byId("savedAnnotations"), active);
  setElementInert(elements.attachmentStrip, active);
  document.querySelectorAll(".mode-tab, .quick-card").forEach((button) => {
    button.disabled = active;
  });
  elements.settingsButton.disabled = active;
  elements.openSettingsInline.disabled = active;
  elements.historyButton.disabled = active;
  elements.newChatButton.disabled = active;
  elements.modelButton.disabled = active;
  elements.attachButton.disabled = active;
  byId("compareTabsButton").disabled = active;
  byId("quickPromptsButton").disabled = active;
  byId("selectionMenuButton").disabled = active;
  byId("selectionSettingsButton").disabled = active;
  setElementInert(byId("comparedPages"), active);
  elements.historySearch.disabled = active;
  elements.historyList.querySelectorAll("button").forEach((button) => {
    button.disabled = active;
  });
  const settingsClosed = !elements.settingsSheet.classList.contains("is-open");
  if (settingsClosed) setElementInert(elements.settingsSheet, false);
  elements.settingsForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = settingsBusy;
  });
  updateContextWindowStepper();
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
  const sequence = ++contextReadSequence;
  try {
    const response = await requestContent("REQUEST_CONTEXT", {}, { signal });
    if (sequence !== contextReadSequence) return false;
    if (typeof response.pageKey !== "string" || !response.pageKey) throw new Error(t("無法識別這個網頁的對話，請重新載入網頁"));
    switchPageConversation(response.pageKey);
    state.page = response.page ?? null;
    const liveSelection = String(response.selection ?? "");
    state.selection = state.quickSelection || (liveSelection === state.ignoredSelection ? "" : liveSelection);
    state.contextAvailable = Boolean(state.page?.text?.trim());
    contextFreshness.markFresh(response.contextRevision);
    renderSelection();
    renderPageToggle();
    if (response.quickAsk) handleBridgeMessage({ type: "QUICK_ASK", ...response.quickAsk });
    if (response.readingPreferenceError) showToast(response.readingPreferenceError, "error");
    return contextFreshness.isFresh;
  } catch (error) {
    if (sequence !== contextReadSequence) return false;
    if (error?.name === "AbortError") {
      throw error;
    }
    state.page = null;
    state.selection = "";
    state.contextAvailable = false;
    contextFreshness.invalidate();
    renderSelection();
    renderPageToggle();
    throw error;
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
      showToast(t("已附上目前可見畫面"));
    }
  } catch (error) {
    if (operationGate.isCurrent(operation)) {
      showToast(error.message || t("無法擷取畫面"), "error");
    }
  } finally {
    endOperation(operation);
  }
}

async function captureElement() {
  const operation = beginOperation("element-picker");
  if (!operation) return;
  showToast(t("請移到網頁上，按一下要擷取的元素"));
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
      showToast(t("已附上 {0}", [response.metadata?.element || t("網頁元素")]));
    }
  } catch (error) {
    if (operationGate.isCurrent(operation)) {
      showToast(error.message || t("無法擷取元素"), "error");
    }
  } finally {
    endOperation(operation);
  }
}

function buildCurrentPayload(prompt, settings = state.settings) {
  if (state.preparedReading) {
    const prepared = state.preparedReading;
    return buildContextPayload({ prompt, page: prepared.compared ? null : prepared.pages[0], includePage: !prepared.compared,
      annotations: prepared.annotations, includeSelection: !prepared.compared && settings.includeSelection,
      comparisonPages: prepared.compared ? prepared.pages : [], element: latestElementMetadata() });
  }
  if (hasAnnotations(settings) && !state.page?.text?.trim()) {
    throw new Error(t("無法讀取頁面上下文，因此不會只傳送標註；請重新整理頁面後再試"));
  }
  const sources = promptSources(settings);
  return buildContextPayload({
    prompt,
    page: state.page && { ...state.page, sources },
    selection: state.selection,
    element: latestElementMetadata(),
    includePage: needsPageContext(settings),
    includeSelection: settings.includeSelection && !state.comparedPages.length,
    annotations: hasAnnotations(settings) ? selectedPassages() : [],
    includeElement: true,
    comparisonPages: state.comparedPages.map(page => ({ ...page, sources: sources.filter(source => source.tabId === page.tabId) })),
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showToast(t("無法複製文字，請允許剪貼簿存取後重試。"), "error");
    return false;
  }
}

async function copyAttachmentImage(attachment) {
  try {
    const blob = dataUrlToBlob(attachment.dataUrl);
    if (!globalThis.ClipboardItem || !navigator.clipboard?.write || blob.type !== "image/png") {
      throw new Error(t("Safari 無法直接複製這張圖片"));
    }
    const write = navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    await write;
    showToast(t("圖片已複製，可貼到 ChatGPT"));
  } catch {
    showToast(t("無法複製圖片，請確認 Safari 支援圖片複製並允許剪貼簿存取。"), "error");
  }
}

async function attachChatGptDraft(handoff, operation) {
  if (demoMode || !relayPanel) throw new Error(t("預覽模式不會連線或模擬登入 ChatGPT；請在已安裝的 Safari 擴充功能使用。"));
  await relayPanel.prepareDraft(handoff, state.attachments);
  if (!operationGate.isCurrent(operation)) return;
  const note = t("已附到 ChatGPT，請確認草稿與圖片上傳完成後再送出。");
  if (elements.liveStatus) elements.liveStatus.textContent = note;
  showToast(note);
  elements.promptInput.value = "";
  if (hasAnnotations()) await consumeSentAnnotations();
  // A bridge acknowledgement does not prove the provider finished uploading files.
  // Keep source screenshots available until the user removes them explicitly.
  autoSizePrompt();
  updateProviderStatus();
}

async function demoAssistant(onDelta, operation) {
  const parts = [
    t("這是一段本機預覽回覆。"),
    t(" Margina 會把頁面、反白文字與圖片分成明確欄位，"),
    t("只有在你按下傳送後才交給指定的 API。"),
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

async function sendToApi(prompt, operation, settings) {
  const sources = promptSources(settings);
  const payload = buildCurrentPayload(prompt, settings);
  const sentAttachments = [...state.attachments];
  const sentAttachmentIds = new Set(sentAttachments.map((attachment) => attachment.id));
  const userContent = buildUserContent({ payload, attachments: sentAttachments });
  const messages = buildConversationMessages({
    history: state.history.slice(-12),
    userContent,
  });
  if (estimateRequestTokens(messages) > requestInputBudget(settings)) {
    throw new Error(t("請求估算仍超過 Context window；請減少問題、對話或附件，或調高容量。未傳送 API 請求。"));
  }
  addMessage("user", prompt, { labels: contextLabels(settings) });
  const assistantMessage = addMessage("assistant", "", { pending: true });
  let streamedText = "";
  let streamFrame = null;
  let pendingDeltas = [];
  const controller = state.abortController;
  const stopStreamPaint = () => {
    if (streamFrame !== null) window.cancelAnimationFrame(streamFrame);
    streamFrame = null;
    pendingDeltas = [];
  };

  try {
    const onDelta = (delta) => {
      if (!operationGate.isCurrent(operation)) return;
      streamedText += delta;
      pendingDeltas.push(delta);
      if (streamFrame !== null) return;
      streamFrame = window.requestAnimationFrame(() => {
        streamFrame = null;
        if (!operationGate.isCurrent(operation)) { pendingDeltas = []; return; }
        const added = pendingDeltas.join("");
        pendingDeltas = [];
        assistantMessage.rawText += added;
        const textNode = assistantMessage.content.firstChild;
        if (textNode) textNode.appendData(added);
        else assistantMessage.content.append(document.createTextNode(added));
        elements.conversation.scrollTop = elements.conversation.scrollHeight;
      });
    };
    const answer = demoMode
      ? await demoAssistant(onDelta, operation)
      : await requestChatCompletion(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            messages,
            stream: settings.stream,
            signal: controller.signal,
          },
          onDelta,
        );
    if (!operationGate.isCurrent(operation)) return;
    if (!answer.trim()) throw new Error(t("API 沒有回傳文字內容。"));
    const finalText = answer;
    stopStreamPaint();
    updateAssistantMessage(assistantMessage, finalText, { complete: true });
    appendCitations(assistantMessage, sources);
    state.history.push(
      { role: "user", content: prompt },
      { role: "assistant", content: finalText },
    );
    await saveActiveConversation();
    if (!operationGate.isCurrent(operation)) return;
    state.attachments = state.attachments.filter(
      (attachment) => !sentAttachmentIds.has(attachment.id),
    );
    renderAttachments();
    elements.promptInput.value = "";
    if (hasAnnotations(settings)) await consumeSentAnnotations();
    if (!operationGate.isCurrent(operation)) return;
    autoSizePrompt();
    updateProviderStatus();
    if (elements.liveStatus) elements.liveStatus.textContent = t("Margina 回覆完成");
    return true;
  } catch (error) {
    stopStreamPaint();
    if (!operationGate.isCurrent(operation)) return;
    if (error?.name === "AbortError") {
      const stoppedText = streamedText || t("已停止產生回覆。");
      updateAssistantMessage(
        assistantMessage,
        stoppedText,
        { complete: true },
      );
      state.history.push(
        { role: "user", content: prompt },
        { role: "assistant", content: stoppedText },
      );
      await saveActiveConversation();
      if (elements.liveStatus) elements.liveStatus.textContent = t("已停止產生回覆");
      return false;
    } else {
      updateAssistantMessage(
        assistantMessage,
        t(error?.message || "無法連線到 API"),
        { error: true, complete: true },
      );
      throw error;
    }
  } finally { stopStreamPaint(); }
}

async function submitPrompt(event) {
  event.preventDefault();
  if (settingsMutations.kind) {
    showToast(t("請等待設定儲存完成"), "error");
    return;
  }
  if (operationGate.kind) {
    if (operationGate.kind === "api") state.abortController?.abort();
    else showToast(t("請先完成目前操作"), "error");
    return;
  }

  const typed = elements.promptInput.value.trim();
  const prompt = typed || (state.attachments.length ? t("請分析附上的內容。") : "");
  if (!prompt) {
    showToast(t("請輸入問題，或先附上一張截圖"), "error");
    elements.promptInput.focus();
    return;
  }

  const settings = { ...state.settings };
  const mode = settings.mode;
  try { if (hasAnnotations(settings)) selectedPassages(); }
  catch (error) { showToast(error.message, "error"); return; }
  if (mode === "chatgpt" && needsPageContext(settings) && !contextFreshness.isFresh) {
    const refreshOperation = beginOperation("context-refresh");
    if (!refreshOperation) return;
    try {
      const refreshed = await refreshContext();
      if (!operationGate.isCurrent(refreshOperation)) return;
      showToast(
        refreshed
          ? t("頁面內容已更新，請再按一次附到 ChatGPT")
          : t("無法更新頁面內容；請重新整理網頁後重試"),
        refreshed ? "info" : "error",
      );
    } catch (error) {
      showToast(t("無法更新頁面內容：{0}", [t(error.message)]), "error");
    } finally {
      endOperation(refreshOperation);
    }
    return;
  }
  let handoff;
  if (mode === "chatgpt") {
    if (longReadingNeeded()) {
      const fingerprint = readingFingerprint(prompt);
      if (state.handoffReading?.fingerprint !== fingerprint) {
        const prepareOperation = beginOperation("context-refresh");
        if (!prepareOperation) return;
        try {
          const plan = await prepareReadingPlans(prompt, settings);
          if (!operationGate.isCurrent(prepareOperation)) return;
          state.handoffReading = { fingerprint, prepared: relevantReading(plan) };
          await releaseReadingPlans(plan);
          showToast(t("長文重點快照已準備；請再按一次附到 ChatGPT"));
        } catch (error) { showToast(error.message, "error"); }
        finally { endOperation(prepareOperation); }
        return;
      }
      state.preparedReading = state.handoffReading.prepared;
    }
    try { handoff = buildPromptText(buildCurrentPayload(prompt)); }
    catch (error) { showToast(error.message, "error"); return; }
  }
  const operation = beginOperation(mode === "api" ? "api" : "chatgpt");
  if (!operation) return;
  if (mode === "api") state.abortController = new AbortController();
  let activeReadingPlan = null;

  try {
    if (!demoMode) await assertCurrentSettings(settings);
    if (mode === "api") {
      assertEndpointSecurity(settings.baseUrl, settings.apiKey);
      if (!settings.model.trim()) throw new Error(t("請先設定模型名稱"));
      const allowed = demoMode || await browserApi.permissions.contains({ origins: [endpointOriginPattern(settings.baseUrl)] });
      if (!allowed) throw new Error(t("請開啟 API 設定並儲存，以允許連線到目前的 API 網域"));
      if (!operationGate.isCurrent(operation) || state.abortController.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
    }
    if (mode === "api" && state.comparedPages.length) {
      const result = await readingRequest("READ_READING_TABS", { items: state.comparedPages.map(page => ({ id: page.tabId, url: page.url })) });
      if (!operationGate.isCurrent(operation) || state.abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
      state.comparedPages = result.pages;
      renderComparedPages();
    }
    if (mode === "api" && !state.comparedPages.length) {
      await refreshContext({ signal: state.abortController.signal });
      if (!contextFreshness.isFresh || (needsPageContext(settings) && !state.contextAvailable)) {
        throw new Error(t("無法取得最新頁面內容；請重新整理網頁後重試。"));
      }
    }
    if (!operationGate.isCurrent(operation)) return;
    if (!demoMode) await assertCurrentSettings(settings);
    if (mode === "api") {
      const signal = state.abortController.signal;
      // Short pages already contain their full text. Prepare a full local snapshot
      // whenever the preview was bounded or the outgoing request needs trimming.
      const initialMessages = currentRequestMessages(prompt, settings);
      if (longReadingNeeded() || estimateRequestTokens(initialMessages) > requestInputBudget(settings)) {
        activeReadingPlan = await prepareReadingPlans(prompt, settings, signal);
        for (const page of activeReadingPlan.plans) await validateReadingPlan(page, signal);
        state.preparedReading = relevantReading(activeReadingPlan);
        // JSON/source overhead may use more than the reserved margin. Re-select
        // locally once with a smaller budget; no provider request has been sent.
        const measured = estimateRequestTokens(currentRequestMessages(prompt, settings));
        if (measured > requestInputBudget(settings)) {
          const reduced = Math.floor(activeReadingPlan.budgetTokens * requestInputBudget(settings) / measured * 0.75);
          await releaseReadingPlans(activeReadingPlan);
          activeReadingPlan = await prepareReadingPlans(prompt, settings, signal, reduced);
          for (const page of activeReadingPlan.plans) await validateReadingPlan(page, signal);
          state.preparedReading = relevantReading(activeReadingPlan);
        }
      }
      if (!operationGate.isCurrent(operation) || signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!demoMode) await assertCurrentSettings(settings);
    }
    if (!operationGate.isCurrent(operation)) return;
    if (mode === "chatgpt") {
      await attachChatGptDraft(handoff, operation);
    } else {
      await sendToApi(prompt, operation, settings);
    }
  } catch (error) {
    if (operationGate.isCurrent(operation) && error?.name !== "AbortError") {
      showToast(error?.message || t("傳送失敗"), "error");
    }
    if (operationGate.isCurrent(operation)) {
      if (state.preparedReading) {
        setLongStatus(`${byId("longProgress").textContent} ${error?.name === "AbortError" ? t("已停止回答") : t("回答未完成")}。`);
      } else if (longReadingNeeded()) {
        setLongStatus(t("頁面上下文準備未完成；請依錯誤提示重新傳送。"));
      }
    }
  } finally {
    if (operationGate.isCurrent(operation)) {
      state.preparedReading = null;
      state.abortController = null;
      endOperation(operation);
    }
    await releaseReadingPlans(activeReadingPlan);
  }
}

function applyStoredSettings(settings) {
  if (Object.keys(DEFAULT_SETTINGS).some(key => state.settings[key] !== settings[key])) invalidateLongPreparation();
  state.settings = mergeSettings(settings);
  renderLanguage();
  renderMode();
  renderPageToggle();
  renderSelection();
  if (bridgePort) sendPanelAction("SET_READING_PREFERENCES");
}

function renderLanguage() {
  const previous = getLanguage();
  setLanguage(state.settings.language);
  localizeDocument();
  if (previous !== getLanguage()) {
    // Keep live citation handlers, request badges and streamed answer nodes.
    for (const element of elements.messageList.querySelectorAll(".message-meta span,.message-context span,.citation-button")) {
      const label = localizedTexts.get(element);
      if (label) element.textContent = t(label.source, label.values);
    }
    for (const button of elements.messageList.querySelectorAll(".message-copy")) button.setAttribute("aria-label", t("複製回覆"));
    renderConversationHistory();
    renderAttachments();
    renderComparedPages();
    relayPanel?.refreshLanguage();
    readingFeatures?.refreshLanguage();
  }
  elements.historyButton.setAttribute("aria-label", elements.historyDrawer.hidden ? t("開啟對話紀錄") : t("返回對話"));
  elements.sidebarTitle.textContent = elements.historyDrawer.hidden ? "Margina" : t("對話紀錄");
  elements.revealKeyButton.setAttribute("aria-label", elements.apiKeyInput.type === "password" ? t("顯示 API Key") : t("隱藏 API Key"));
}

async function assertCurrentSettings(snapshot) {
  const latest = await loadSettings();
  if (Object.keys(DEFAULT_SETTINGS).some((key) => latest[key] !== snapshot[key])) {
    applyStoredSettings(latest);
    throw new Error(t("設定已由另一頁更新，請確認新的設定後再次傳送"));
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;
  if (location.protocol === "safari-web-extension:") {
    if (changes.settingsRevision || changes.settings || changes.conversations) refreshSavedState();
    return;
  }
  savedReadSequence++;
  try {
    if (changes.settings) applyStoredSettings(changes.settings.newValue);
    if (changes.conversations) {
      const store = normalizeConversationStore(changes.conversations.newValue);
      state.conversations = store.conversations;
      state.pageSelections = store.pageSelections;
      renderConversationHistory();
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function refreshSavedState() {
  if (demoMode) return;
  const sequence = ++savedReadSequence;
  try {
    const [settings, store] = await Promise.all([loadSettings(), loadConversationStore()]);
    if (sequence !== savedReadSequence) return;
    applyStoredSettings(settings);
    state.conversations = store.conversations;
    state.pageSelections = store.pageSelections;
    renderConversationHistory();
  } catch (error) {
    if (sequence === savedReadSequence) showToast(error.message, "error");
  }
}

function setBackgroundInert(inert) {
  for (const region of [
    elements.topbar,
    elements.chatgptBanner,
    elements.conversation,
    elements.composerDock,
    elements.historyDrawer,
  ]) {
    setElementInert(region, inert);
  }
}

function focusableElements(container) {
  return Array.from(
    container.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
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

function updateContextWindowStepper() {
  const input = elements.contextWindowInput;
  const invalid = input.disabled || !input.validity.valid;
  elements.doubleContextWindowButton.disabled = invalid || input.valueAsNumber >= Number(input.max);
  elements.halveContextWindowButton.disabled = invalid || input.valueAsNumber <= Number(input.min);
}

function stepContextWindow(factor) {
  const input = elements.contextWindowInput;
  if (input.disabled || !input.validity.valid) return;
  const next = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(input.valueAsNumber * factor)));
  if (next === input.valueAsNumber) return;
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function openSettings() {
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
    return;
  }
  closePopovers({ restoreFocus: true });
  modalTrigger = document.activeElement;
  settingsFormSnapshot = { ...state.settings };
  setValidationStatus();
  elements.baseUrlInput.value = state.settings.baseUrl;
  elements.apiKeyInput.value = state.settings.apiKey;
  elements.modelInput.value = state.settings.model;
  elements.languageInput.value = state.settings.language;
  elements.contextWindowInput.value = String(state.settings.contextWindowTokens);
  updateContextWindowStepper();
  elements.streamInput.checked = state.settings.stream;
  setElementInert(elements.settingsSheet, false);
  elements.settingsSheet.classList.add("is-open");
  elements.settingsSheet.setAttribute("aria-hidden", "false");
  elements.sheetScrim.hidden = false;
  setBackgroundInert(true);
  elements.baseUrlInput.focus();
}

function closeSettings() {
  settingsValidationController?.abort();
  elements.settingsSheet.classList.remove("is-open");
  elements.settingsSheet.setAttribute("aria-hidden", "true");
  setElementInert(elements.settingsSheet, true);
  elements.sheetScrim.hidden = true;
  setBackgroundInert(false);
  modalTrigger?.focus?.();
  modalTrigger = undefined;
}

function readSettingsForm() {
  const settings = mergeSettings({
    ...(settingsFormSnapshot || state.settings),
    baseUrl: elements.baseUrlInput.value.trim(),
    apiKey: elements.apiKeyInput.value.trim(),
    model: elements.modelInput.value.trim(),
    language: elements.languageInput.value,
    contextWindowTokens: Number(elements.contextWindowInput.value),
    stream: elements.streamInput.checked,
  });
  assertEndpointSecurity(settings.baseUrl, settings.apiKey);
  if (!settings.model) throw new Error(t("模型名稱不可留空"));
  return settings;
}

function setValidationStatus(text = "") {
  elements.validationStatus.textContent = t(text);
  elements.validationStatus.hidden = !text;
}

async function validateSettings() {
  if (operationGate.kind || settingsMutations.kind) return;
  if (demoMode) { setValidationStatus(t("預覽模式不會傳送驗證請求")); return; }
  let settings;
  try { settings = readSettingsForm(); }
  catch (error) { setValidationStatus(error.message); return; }
  const mutation = beginSettingsMutation("validate", settings);
  if (!mutation) return;
  const controller = new AbortController();
  settingsValidationController = controller;
  elements.validateKeyButton.textContent = t("驗證中…");
  setValidationStatus(t("正在傳送簡短測試請求…"));
  try {
    const { allowed } = await requestEndpointPermissionWithPriorState(browserApi, settings.baseUrl);
    if (controller.signal.aborted) return;
    if (!allowed) { setValidationStatus(t("未允許連線到這個 API 網域")); return; }
    await requestChatCompletion({
      baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model,
      messages: [{ role: "user", content: "Reply with OK only." }],
      stream: false, timeoutMs: 30_000, maxResponseChars: 1000, signal: controller.signal,
    }, undefined, (url, options) => fetch(url, { ...options, redirect: "error", credentials: "omit", cache: "no-store" }));
    if (!controller.signal.aborted) setValidationStatus(t("驗證成功：API 與模型可正常回應。設定尚未儲存。"));
  } catch (error) {
    if (!controller.signal.aborted) {
      // Provider errors may echo credentials. Display status only, never their body.
      const status = Number.isInteger(error?.status) && error.status > 0 ? `（HTTP ${error.status}）` : "";
      setValidationStatus(t("驗證失敗{0}，請確認 API 位址、Key、模型及網路連線。設定未變更。", [status]));
    }
  } finally {
    if (settingsValidationController === controller) settingsValidationController = undefined;
    elements.validateKeyButton.textContent = t("驗證 API Key");
    endSettingsMutation(mutation);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
    return;
  }
  let next;
  const previous = settingsFormSnapshot || { ...state.settings };
  try {
    next = readSettingsForm();
  } catch (error) {
    showToast(error?.message || t("無法儲存設定"), "error");
    return;
  }

  const fields = ["baseUrl", "apiKey", "model", "contextWindowTokens", "stream", "language"];
  const changed = fields.filter((key) => next[key] !== previous[key]);
  const patch = Object.fromEntries(changed.map((key) => [key, next[key]]));
  const expected = Object.fromEntries(changed.map((key) => [key, previous[key]]));
  for (const key of ["baseUrl", "apiKey", "model"]) expected[key] = previous[key];
  const providerChanged = providerConfigurationChanged(previous, next);
  const mutation = beginSettingsMutation("save", next);
  if (!mutation) return;
  let newlyGrantedPermission = false;
  let conversationSaved = true;

  try {
    const { allowed, wasPresent } = demoMode
      ? { allowed: true, wasPresent: true }
      : await requestEndpointPermissionWithPriorState(browserApi, next.baseUrl);
    newlyGrantedPermission = allowed && wasPresent === false;
    if (!allowed) throw new Error(t("未允許 Margina 連線到這個 API 網域"));
    if (!settingsMutations.isCurrent(mutation)) return;
    const saved = await persistSettings(patch, expected, true);
    if (!settingsMutations.isCurrent(mutation)) return;
    applyStoredSettings(saved.settings);
    if (providerChanged) {
      conversationSaved = await startNewConversation({ clearDraft: false, clearAttachments: true });
    }
    closeSettings();
    if (conversationSaved || saved.warning) showToast(
      saved.warning
        ? t("設定已儲存；{0}", [t(saved.warning)])
        : t("API 設定已儲存"),
      saved.warning ? "error" : "info",
    );
  } catch (error) {
    if (settingsMutations.isCurrent(mutation)) {
      showToast(
        newlyGrantedPermission
          ? t("{0}；如不再使用，新授權網域可在 Safari 設定中移除", [t(error?.message || "無法儲存設定")])
          : error?.message || t("無法儲存設定"),
        "error",
      );
    }
  } finally {
    endSettingsMutation(mutation);
  }
}

function resetConversationState({ clearDraft = true, clearAttachments: removeAttachments = true } = {}) {
  state.preparedReading = state.handoffReading = null;
  setLongStatus("");
  state.retainedSelections = [];
  state.annotationPageUrl = null;
  state.annotationPageIdentity = null;
  state.ignoredSelection = "";
  state.comparedPages = [];
  state.quickSelection = "";
  state.selection = "";
  renderComparedPages();
  renderPageToggle();
  renderSelection();
  state.history = [];
  state.savedMessageCount = 0;
  if (removeAttachments) clearAttachments();
  renderConversationTranscript();
  if (clearDraft) {
    elements.promptInput.value = "";
    autoSizePrompt();
  }
}

function switchPageConversation(pageKey) {
  if (pageKey === state.pageKey) return;
  const firstPage = state.pageKey === null;
  if (!firstPage) {
    state.abortController?.abort();
    state.abortController = null;
    operationGate.invalidate();
    invalidateLongPreparation();
  }
  resetConversationState({ clearDraft: !firstPage });
  state.pageKey = pageKey;
  const selected = Object.hasOwn(state.pageSelections, pageKey)
    ? state.conversations.find(item => item.id === state.pageSelections[pageKey] && item.pageKey === pageKey)
    : state.conversations.find(item => item.pageKey === pageKey);
  state.activeConversationId = selected?.id ?? createConversationId();
  state.history = selected?.messages.map(({ role, content }) => ({ role, content })) ?? [];
  state.savedMessageCount = state.history.length;
  renderConversationTranscript();
  renderConversationHistory();
  closeConversationHistory({ restoreFocus: false });
  renderActivity();
}

async function consumeSentAnnotations() {
  contextReadSequence++;
  const identity = state.page?.identity;
  state.ignoredSelection = state.selection;
  state.selection = state.quickSelection = "";
  state.retainedSelections = [];
  state.annotationPageUrl = state.annotationPageIdentity = null;
  renderSelection();
  try { await requestContent("CLEAR_SELECTION", { identity }); }
  catch (error) { showToast(t("訊息已送出，但無法清除網頁反白：{0}", [t(error.message)]), "error"); }
}

async function startNewConversation(options) {
  state.activeConversationId = createConversationId();
  resetConversationState(options);
  if (state.pageKey) state.pageSelections[state.pageKey] = null;
  renderConversationHistory();
  try {
    await persistConversationSelection();
    return true;
  } catch {
    showToast(t("新對話已開啟，但無法儲存目前選擇；重新開啟時可能回到先前對話。"), "error");
    return false;
  }
}

function openConversationHistory() {
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
    return;
  }
  closePopovers();
  historyTrigger = document.activeElement;
  elements.historySearch.value = "";
  renderConversationHistory();
  elements.historyDrawer.hidden = false;
  elements.historyButton.setAttribute("aria-expanded", "true");
  elements.historyButton.setAttribute("aria-label", t("返回對話"));
  elements.sidebarTitle.textContent = t("對話紀錄");
  for (const region of [elements.conversation, elements.composerDock, elements.chatgptBanner]) region.hidden = true;
  relayPanel?.setActive(false);
  elements.historySearch.focus();
}

function closeConversationHistory({ restoreFocus = true } = {}) {
  elements.historyDrawer.hidden = true;
  elements.historyButton.setAttribute("aria-expanded", "false");
  elements.historyButton.setAttribute("aria-label", t("開啟對話紀錄"));
  elements.sidebarTitle.textContent = "Margina";
  for (const region of [elements.conversation, elements.composerDock]) region.hidden = false;
  renderMode();
  if (restoreFocus) historyTrigger?.focus?.();
  historyTrigger = undefined;
}

async function selectConversation(id) {
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
    return;
  }
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;
  if (conversation.pageKey && conversation.pageKey !== state.pageKey) return;
  state.preparedReading = state.handoffReading = null;
  setLongStatus("");
  const operation = beginOperation("select-conversation");
  state.activeConversationId = conversation.id;
  state.history = conversation.messages.map(({ role, content }) => ({ role, content }));
  state.savedMessageCount = state.history.length;
  clearAttachments();
  state.retainedSelections = [];
  state.annotationPageUrl = null;
  state.annotationPageIdentity = null;
  state.ignoredSelection = "";
  state.comparedPages = [];
  state.quickSelection = "";
  renderComparedPages();
  renderPageToggle();
  renderSelection();
  elements.promptInput.value = "";
  autoSizePrompt();
  renderConversationTranscript();
  renderConversationHistory();
  closeConversationHistory({ restoreFocus: false });
  try {
    await persistConversationSelection();
  } catch {
    showToast(t("無法記住目前對話"), "error");
  } finally {
    endOperation(operation);
    elements.promptInput.focus();
  }
}

async function newConversation() {
  if (operationGate.kind || settingsMutations.kind) {
    showToast(t("請先完成或停止目前操作"), "error");
    return;
  }
  const operation = beginOperation("new-conversation");
  try {
    if (state.settings.mode === "chatgpt") relayPanel?.newChat();
    const saved = await startNewConversation();
    closeConversationHistory({ restoreFocus: false });
    if (saved) showToast(t("已開始新對話"));
  } finally {
    endOperation(operation);
  }
}

async function toggleSetting(key, render, errorMessage) {
  if (operationGate.kind || settingsMutations.kind) return;
  const previous = state.settings;
  const next = { ...previous, [key]: !previous[key] };
  const mutation = beginSettingsMutation("context", next);
  if (!mutation) return;
  try {
    const saved = await persistSettings({ [key]: next[key] }, { [key]: previous[key] });
    state.settings = saved.settings;
    renderMode();
    renderPageToggle();
    renderSelection();
  } catch (error) {
    if (settingsMutations.isCurrent(mutation)) {
      render();
      showToast(error.message || errorMessage, "error");
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

function sendPanelAction(type, payload) {
  requestContent(type, payload).catch((error) => showToast(error.message, "error"));
}

function closePopovers({ restoreFocus = false } = {}) {
  if (!activePopover) return;
  const { panel, trigger } = activePopover;
  panel.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  activePopover = undefined;
  if (restoreFocus) trigger.focus();
}

function togglePopover(panel, trigger) {
  if (operationGate.kind || settingsMutations.kind) return;
  const wasOpen = !panel.hidden;
  closePopovers();
  if (wasOpen) return;
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  activePopover = { panel, trigger };
  (panel.querySelector('[aria-selected="true"]') || panel.querySelector("button")).focus();
}

function bindEvents() {
  byId("retainSelectionButton").addEventListener("click", retainSelection);
  readingFeatures = createReadingFeatures({
    document, settings: () => state.settings, page: () => state.page, request: readingRequest,
    canOpen: () => !operationGate.kind && !settingsMutations.kind,
    setModal: value => { closePopovers(); setBackgroundInert(value); if (!value) renderPageToggle(); },
    usePrompt: insertPrompt, notify: showToast,
    attach: pages => { invalidateLongPreparation(); state.comparedPages = pages; renderComparedPages(); renderPageToggle(); renderSelection(); },
    saveSettings: async (patch, expected) => {
      const mutation = beginSettingsMutation("reading-settings", state.settings);
      if (!mutation) throw new Error(t("請等待目前操作完成"));
      try { const saved = await persistSettings(patch, expected); applyStoredSettings(saved.settings); }
      finally { endSettingsMutation(mutation); }
    },
  });
  byId("compareTabsButton").addEventListener("click", () => readingFeatures.openTabs());
  byId("quickPromptsButton").addEventListener("click", () => readingFeatures.openCommands());
  byId("selectionMenuButton").addEventListener("click", () => readingFeatures.openSelectionSettings());
  byId("selectionSettingsButton").addEventListener("click", () => {
    closeSettings();
    readingFeatures.openSelectionSettings();
  });
  elements.modelButton.addEventListener("click", () => togglePopover(elements.modeMenu, elements.modelButton));
  elements.attachButton.addEventListener("click", () => togglePopover(elements.attachMenu, elements.attachButton));
  document.addEventListener("click", (event) => {
    if (activePopover && !activePopover.panel.contains(event.target) && !activePopover.trigger.contains(event.target)) closePopovers();
  });
  document.addEventListener("focusin", (event) => {
    if (activePopover && !activePopover.panel.contains(event.target) && !activePopover.trigger.contains(event.target)) closePopovers();
  });
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", () => { closePopovers({ restoreFocus: true }); applyMode(button.dataset.mode); });
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
      next.tabIndex = 0;
      button.tabIndex = -1;
      next.focus();
    });
  });
  document.querySelectorAll(".quick-card").forEach((button) => {
    button.addEventListener("click", () => {
      invalidateLongPreparation();
      elements.promptInput.value = button.dataset.prompt || "";
      autoSizePrompt();
      elements.promptInput.focus();
    });
  });

  elements.promptInput.addEventListener("input", () => { invalidateLongPreparation(); autoSizePrompt(); });
  elements.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.composerForm.requestSubmit();
    }
  });
  elements.composerForm.addEventListener("submit", submitPrompt);
  elements.captureButton.addEventListener("click", () => { closePopovers({ restoreFocus: true }); captureViewport(); });
  elements.elementButton.addEventListener("click", () => { closePopovers({ restoreFocus: true }); captureElement(); });
  elements.selectionToggle.addEventListener("click", () =>
    toggleSetting("includeSelection", renderSelection, t("無法儲存反白設定")),
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
  elements.validateKeyButton.addEventListener("click", validateSettings);
  elements.settingsForm.addEventListener("input", () => setValidationStatus());
  elements.doubleContextWindowButton.addEventListener("click", () => stepContextWindow(2));
  elements.halveContextWindowButton.addEventListener("click", () => stepContextWindow(0.5));
  elements.contextWindowInput.addEventListener("input", updateContextWindowStepper);
  elements.contextWindowInput.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      stepContextWindow(event.key === "ArrowUp" ? 2 : 0.5);
    }
  });
  window.addEventListener("pagehide", () => settingsValidationController?.abort());
  elements.revealKeyButton.addEventListener("click", () => {
    const revealing = elements.apiKeyInput.type === "password";
    elements.apiKeyInput.type = revealing ? "text" : "password";
    elements.revealKeyButton.setAttribute("aria-label", revealing ? t("隱藏 API Key") : t("顯示 API Key"));
  });
  elements.historyButton.addEventListener("click", () => {
    if (elements.historyDrawer.hidden) openConversationHistory();
    else closeConversationHistory();
  });
  elements.historySearch.addEventListener("input", renderConversationHistory);
  elements.closeHistoryButton.addEventListener("click", () => closeConversationHistory());
  elements.newChatButton.addEventListener("click", newConversation);
  elements.closeButton.addEventListener("click", () => {
    operationGate.invalidate();
    state.preparedReading = state.handoffReading = null;
    state.abortController?.abort();
    state.abortController = null;
    renderActivity();
    sendPanelAction("CLOSE_PANEL");
  });
  elements.closePreviewButton.addEventListener("click", closePreview);
  elements.copyPreviewButton.addEventListener("click", () => {
    const attachment = state.attachments.find((item) => item.id === state.previewAttachmentId);
    if (attachment) copyAttachmentImage(attachment);
  });
  document.addEventListener("keydown", (event) => {
    if (readingFeatures.isOpen) return;
    if (activePopover && event.key === "Escape") {
      event.preventDefault();
      closePopovers({ restoreFocus: true });
      return;
    }
    if (operationGate.kind === "element-picker") {
      if (event.key === "Escape") {
        event.preventDefault();
        sendPanelAction("CANCEL_PICKER");
      } else if (event.key === "Tab") {
        event.preventDefault();
        sendPanelAction("PICKER_NAVIGATE", {
          direction: event.shiftKey ? -1 : 1,
        });
      } else if (event.key === "Enter") {
        event.preventDefault();
        sendPanelAction("PICKER_CONFIRM");
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
      return;
    }
    if (!elements.historyDrawer.hidden && event.key === "Escape") closeConversationHistory();
  });
}

async function initialize() {
  if (!demoMode && !browserApi?.runtime?.id) {
    throw new Error(t("Margina 擴充功能無法使用；請從 Safari 工具列重新開啟。"));
  }
  setElementInert(elements.settingsSheet, true);
  const [settings, conversationStore] = await Promise.all([
    loadSettings(),
    loadConversationStore(),
  ]);
  state.settings = settings;
  renderLanguage();
  relayPanel = createRelayPanel({
    root: elements.chatgptBanner,
    sendCommand: async action => {
      if (demoMode) throw new Error(t("預覽模式不會登入 ChatGPT"));
      return sendNativeRelayCommand(browserApi, action, location);
    },
  });
  window.addEventListener("pagehide", event => { if (!event.persisted) relayPanel.destroy(); });
  const stopAppleControls = installAppleControls(document);
  window.addEventListener("pagehide", event => { if (!event.persisted) stopAppleControls(); });
  bindEvents();
  if (!demoMode) {
    browserApi.storage.onChanged.addListener(handleStorageChange);
    window.addEventListener("focus", refreshSavedState);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshSavedState();
    });
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) browserApi.storage.onChanged.removeListener(handleStorageChange);
    });
  }
  state.conversations = conversationStore.conversations;
  state.pageSelections = conversationStore.pageSelections;
  await applyMode(state.settings.mode, { save: false });
  renderConversationTranscript();
  renderConversationHistory();
  renderPageToggle();
  renderSelection();
  renderAttachments();
  autoSizePrompt();
  await refreshContext();
  if (demoMode) document.documentElement.dataset.demo = "true";
}

initialize().catch((error) => showToast(error?.message || t("Margina 無法啟動"), "error"));
