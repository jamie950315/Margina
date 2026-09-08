import { buildBridgeUrl, createBridgeToken, extensionOrigin } from "../core/bridge.js";
import { createFixedPageLayout } from "./page-reflow.js";
import { createPageMediaLayout } from "./page-media.js";
import { siteLayoutCSS } from "./site-layout.js";
import { createPanelMotion } from "./panel-motion.js";
import { createReadingTools, locateQuote, clearReadingHighlights } from "./reading-tools.js";
import { createLongReader } from "./long-reader.js";
import {
  DEFAULT_PANEL_WIDTH,
  PAGE_LAYOUT_ATTRIBUTE,
  PAGE_ORIGINAL_PADDING_PROPERTY,
  PAGE_PANEL_WIDTH_PROPERTY,
  clampPanelWidth,
  cssPropertyName,
  createPageLayoutController,
  panelWidthBounds,
  panelWidthFromDrag,
  panelWidthFromKey,
} from "../core/panel-layout.js";
import {
  computeCropBox,
  describeElementData,
  hasCaptureLayoutChanged,
  nextPickerIndex,
  pickerActionForKey,
  rectIntersectsViewport,
} from "../core/page-context.js";
import {
  cssPathFor,
  readPageContext,
  readSelectedText,
  resolveRememberedSelection,
} from "./page-reader.js";

const browserApi = globalThis.browser ?? globalThis.chrome;
const PAGE_LAYOUT_STYLE_ID = "safai-extension-page-layout-style";
const PANEL_GUTTER = 10;

function visiblePanelWidth(reservedWidth) {
  return Math.max(0, reservedWidth - PANEL_GUTTER * 2);
}

function nextPaint() {
  return new Promise((resolve, reject) => {
    let frame;
    const timeout = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error("Safari 畫面未更新，請將視窗移到前景後重試"));
    }, 2000);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("無法讀取截圖"));
    image.src = dataUrl;
  });
}

async function cropScreenshot(dataUrl, rect, viewport) {
  const image = await loadImage(dataUrl);
  const crop = computeCropBox(rect, viewport, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("無法建立截圖畫布");
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height,
  );
  return canvas.toDataURL("image/png");
}

function rectData(element) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  };
}

function captureLayout(element) {
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    rect: rectData(element),
  };
}

function runContentBridge() {
  if (globalThis.__safaiTogglePanel) return;

  const panelUrl = browserApi.runtime.getURL("panel.html");
  const panelOrigin = extensionOrigin(panelUrl);
  const bridgeToken = createBridgeToken();
  let panelHost;
  let panelShadow;
  let panelFrame;
  let panelResizeHandle;
  let cancelPanelResize;
  let panelPort;
  let panelVisible = false;
  let panelWidth = clampPanelWidth(DEFAULT_PANEL_WIDTH, innerWidth);
  let lastSelection = readSelectedText();
  let selectionTimer;
  let currentPicker;
  let contextRevision = 0;
  let contextInvalidationTimer;
  let lastObservedUrl = location.href;
  let identityUrl = location.href;
  let pageIdentity = createBridgeToken();
  const longReader = createLongReader(document);
  let pendingQuickAsk;
  let panelReady = false;
  let readingPreferenceError = "";
  const readingTools = createReadingTools({
    document, window, enabled: false,
    onAsk(draft) {
      pendingQuickAsk = draft;
      lastSelection = draft.selection;
      showPanel();
      if (panelReady && panelPort) {
        postToPanel({ type: "QUICK_ASK", ...draft });
        pendingQuickAsk = undefined;
      }
    },
  });
  async function refreshReadingPreferences() {
    if (!browserApi.runtime.id) return;
    try {
      const response = await browserApi.runtime.sendMessage({ type: "GET_READING_PREFERENCES" });
      if (!response?.ok || typeof response.selectionTools !== "boolean") throw new Error("無法讀取選取工具設定");
      readingTools.setEnabled(response.selectionTools);
      readingPreferenceError = "";
    } catch {
      readingTools.setEnabled(false);
      readingPreferenceError = "無法讀取選取工具設定；請重新開啟側欄後再試";
    }
  }
  refreshReadingPreferences();
  window.addEventListener("focus", refreshReadingPreferences);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshReadingPreferences(); });
  const rootLayout = createPageLayoutController(document.documentElement, () =>
    getComputedStyle(document.documentElement).paddingRight,
  );
  const fixedLayout = createFixedPageLayout(document, () => innerWidth);
  const mediaLayout = createPageMediaLayout(document, () => {
    if (panelVisible) fixedLayout.rescan();
  });
  const pageLayout = {
    apply(width) {
      const siteStyle = document.getElementById(`${PAGE_LAYOUT_STYLE_ID}-site`);
      const css = siteLayoutCSS(location.hostname, innerWidth - width);
      if (siteStyle && siteStyle.textContent !== css) siteStyle.textContent = css;
      rootLayout.apply(width);
      mediaLayout.apply(width);
      fixedLayout.apply(width);
      fixedLayout.rescan();
    },
    clear() { fixedLayout.clear(); mediaLayout.clear(); rootLayout.clear(); },
  };
  const panelMotion = createPanelMotion({
    view: window,
    render(width) {
      rootLayout.apply(width);
      if (panelHost) {
        setImportantStyle(panelHost, "transform", `translateX(${Math.max(0, panelWidth - width)}px)`);
      }
    },
    settle(width) {
      if (!width) pageLayout.clear();
      if (panelHost) {
        setImportantStyle(panelHost, "display", panelVisible ? "block" : "none");
        setImportantStyle(panelHost, "transform", "none");
      }
    },
  });

  function setImportantStyle(element, property, value) {
    element.style.setProperty(cssPropertyName(property), value, "important");
  }

  function panelHasFocus() {
    return (
      document.activeElement === panelFrame ||
      (document.activeElement === panelHost && panelShadow?.activeElement === panelFrame)
    );
  }

  function postToPanel(message, port = panelPort) {
    port?.postMessage(message);
  }

  async function handlePortRequest(message, replyPort) {
    const { requestId } = message;
    try {
      const response = await handlePanelRequest(message);
      postToPanel({ type: "RESPONSE", requestId, ...response }, replyPort);
    } catch (error) {
      postToPanel(
        {
          type: "RESPONSE",
          requestId,
          ok: false,
          error: error?.message || "操作失敗",
        },
        replyPort,
      );
    }
  }

  function connectPanel() {
    panelPort?.close();
    panelPort = undefined;
    const channel = new MessageChannel();
    const trustedPort = channel.port1;
    panelPort = trustedPort;
    trustedPort.onmessage = (event) => handlePortRequest(event.data ?? {}, trustedPort);
    trustedPort.start();
    panelFrame.contentWindow?.postMessage(
      { type: "SAFAI_BRIDGE_CONNECT", token: bridgeToken },
      panelOrigin,
      [channel.port2],
    );
  }

  function ensurePageLayoutStyle() {
    if (document.getElementById(PAGE_LAYOUT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_LAYOUT_STYLE_ID;
    style.textContent = `
      html[${PAGE_LAYOUT_ATTRIBUTE}] {
        box-sizing: border-box !important;
        width: calc(100% - var(${PAGE_PANEL_WIDTH_PROPERTY}, ${DEFAULT_PANEL_WIDTH}px)) !important;
        min-width: 0 !important;
        margin-right: var(${PAGE_PANEL_WIDTH_PROPERTY}, ${DEFAULT_PANEL_WIDTH}px) !important;
      }
    `;
    (document.head || document.documentElement).append(style);
    const siteStyle = document.createElement("style");
    siteStyle.id = `${PAGE_LAYOUT_STYLE_ID}-site`;
    (document.head || document.documentElement).append(siteStyle);
  }

  function updateResizeHandle() {
    if (!panelResizeHandle) return;
    const { min, max } = panelWidthBounds(innerWidth);
    panelResizeHandle.setAttribute("aria-valuemin", String(Math.round(visiblePanelWidth(min))));
    panelResizeHandle.setAttribute("aria-valuemax", String(Math.round(visiblePanelWidth(max))));
    panelResizeHandle.setAttribute("aria-valuenow", String(Math.round(visiblePanelWidth(panelWidth))));
    panelResizeHandle.setAttribute("aria-valuetext", `${Math.round(visiblePanelWidth(panelWidth))} 像素`);
  }

  function setPanelWidth(width) {
    panelMotion.finish();
    panelWidth = clampPanelWidth(width, innerWidth);
    if (panelHost) setImportantStyle(panelHost, "width", `${visiblePanelWidth(panelWidth)}px`);
    if (panelVisible) {
      pageLayout.apply(panelWidth);
      panelMotion.to(panelWidth, { immediate: true });
    }
    updateResizeHandle();
    return panelWidth;
  }

  function createResizeHandle() {
    const style = document.createElement("style");
    style.textContent = `
      /* The material lives outside the iframe so Safari can blur the page behind it. */
      .panel-material {
        position: absolute;
        inset: 0;
        border-radius: 22px;
        pointer-events: none;
        background: linear-gradient(145deg, rgba(255, 255, 255, .48), rgba(255, 255, 255, .04) 58%, rgba(70, 80, 110, .06)), rgba(234, 237, 244, .72);
        -webkit-backdrop-filter: blur(36px) saturate(1.45);
        backdrop-filter: blur(36px) saturate(1.45);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .8), inset 0 0 0 .5px rgba(255, 255, 255, .42),
          0 0 0 .5px rgba(40, 48, 64, .12), -4px 10px 32px rgba(0, 0, 0, .16);
      }
      @media (prefers-color-scheme: dark) {
        .panel-material {
          background: linear-gradient(145deg, rgba(255, 255, 255, .10), rgba(255, 255, 255, .015) 55%, rgba(0, 0, 0, .10)), rgba(56, 57, 61, .70);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, .29), inset 0 0 0 .5px rgba(255, 255, 255, .17),
            0 0 0 .5px rgba(0, 0, 0, .18), -4px 10px 32px rgba(0, 0, 0, .32);
        }
      }
      @media (prefers-reduced-transparency: reduce) {
        .panel-material {
          background: #f5f5f7;
          -webkit-backdrop-filter: none;
          backdrop-filter: none;
        }
      }
      @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
        .panel-material { background: #2b2c30; }
      }
      .resize-handle {
        position: absolute;
        inset: 0 auto 0 0;
        z-index: 4;
        width: 14px;
        transform: translateX(-50%);
        cursor: col-resize;
        touch-action: none;
        user-select: none;
        outline: none;
      }
      .resize-handle::before {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 3px;
        height: 54px;
        border-radius: 999px;
        background: rgba(120, 120, 128, .45);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, .35);
        opacity: 0;
        transform: translate(-50%, -50%);
        transition: opacity 120ms ease, background-color 120ms ease, height 120ms ease;
      }
      .resize-handle:hover::before,
      .resize-handle:focus-visible::before,
      .resize-handle.is-dragging::before {
        height: 72px;
        background: #007aff;
        opacity: 1;
      }
      .resize-handle:focus-visible::after {
        content: "";
        position: absolute;
        inset: 8px 2px;
        border: 2px solid #007aff;
        border-radius: 999px;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, .7);
      }
      @media (prefers-reduced-motion: reduce) {
        .resize-handle::before { transition: none; }
      }
    `;

    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.tabIndex = 0;
    handle.title = "拖曳調整 SafAI 側邊欄寬度";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", "調整 SafAI 側邊欄寬度");

    let dragState;

    function updateResizeFromPointer(event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      setPanelWidth(
        panelWidthFromDrag({
          startWidth: dragState.startWidth,
          startX: dragState.startX,
          currentX: event.clientX,
          viewportWidth: innerWidth,
        }),
      );
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") finishResize();
    }

    function finishResize(event) {
      if (!dragState || (event?.pointerId != null && event.pointerId !== dragState.pointerId)) {
        return;
      }
      const pointerId = dragState.pointerId;
      dragState = undefined;
      window.removeEventListener("pointermove", updateResizeFromPointer, true);
      window.removeEventListener("pointerup", finishResize, true);
      window.removeEventListener("pointercancel", finishResize, true);
      window.removeEventListener("blur", finishResize, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange, true);
      handle.classList.remove("is-dragging");
      panelFrame.style.pointerEvents = "";
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      event.stopPropagation();
      finishResize();
      dragState = {
        pointerId: event.pointerId,
        startWidth: panelWidth,
        startX: event.clientX,
      };
      handle.classList.add("is-dragging");
      panelFrame.style.pointerEvents = "none";
      handle.focus({ preventScroll: true });
      window.addEventListener("pointermove", updateResizeFromPointer, true);
      window.addEventListener("pointerup", finishResize, true);
      window.addEventListener("pointercancel", finishResize, true);
      window.addEventListener("blur", finishResize, true);
      document.addEventListener("visibilitychange", handleVisibilityChange, true);
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("lostpointercapture", finishResize);

    handle.addEventListener("keydown", (event) => {
      const nextWidth = panelWidthFromKey({
        width: panelWidth,
        key: event.key,
        shiftKey: event.shiftKey,
        viewportWidth: innerWidth,
      });
      if (nextWidth == null) return;
      event.preventDefault();
      event.stopPropagation();
      setPanelWidth(nextWidth);
    });

    panelResizeHandle = handle;
    cancelPanelResize = () => finishResize();
    updateResizeHandle();
    return { style, handle };
  }

  function createPanel() {
    if (panelHost) return;

    ensurePageLayoutStyle();
    panelHost = document.createElement("div");
    panelHost.id = "safai-extension-panel-host";
    const hostStyles = {
      all: "initial",
      position: "fixed",
      inset: `${PANEL_GUTTER}px ${PANEL_GUTTER}px ${PANEL_GUTTER}px auto`,
      width: `${visiblePanelWidth(panelWidth)}px`,
      height: `calc(100vh - ${PANEL_GUTTER * 2}px)`,
      zIndex: "2147483646",
      display: "none",
      overflow: "visible",
    };
    for (const [property, value] of Object.entries(hostStyles)) {
      setImportantStyle(panelHost, property, value);
    }

    panelShadow = panelHost.attachShadow({ mode: "closed" });
    const material = document.createElement("div");
    material.className = "panel-material";
    material.setAttribute("aria-hidden", "true");
    panelFrame = document.createElement("iframe");
    panelFrame.title = "SafAI 側邊欄";
    panelFrame.src = buildBridgeUrl(panelUrl, bridgeToken);
    panelFrame.setAttribute("allow", "clipboard-write");
    Object.assign(panelFrame.style, {
      all: "initial",
      position: "relative",
      display: "block",
      width: "100%",
      height: "100%",
      border: "0",
      colorScheme: "light dark",
      borderRadius: "22px",
      background: "transparent",
    });
    panelFrame.addEventListener("load", connectPanel);
    const resizeHandle = createResizeHandle();
    panelShadow.append(resizeHandle.style, material, panelFrame, resizeHandle.handle);
    document.documentElement.append(panelHost);
  }

  function showPanel() {
    createPanel();
    panelVisible = true;
    pageLayout.apply(panelWidth);
    // Only the root reservation is interpolated. Media-rule discovery and
    // fixed-element compensation are evaluated once at the endpoint.
    rootLayout.apply(panelMotion.value);
    setImportantStyle(panelHost, "display", "block");
    setImportantStyle(panelHost, "pointer-events", "auto");
    setImportantStyle(panelHost, "transform", `translateX(${Math.max(0, panelWidth - panelMotion.value)}px)`);
    panelMotion.to(panelWidth);
  }

  function hidePanel() {
    if (!panelHost) return;
    cancelPanelResize?.();
    currentPicker?.cancel();
    panelVisible = false;
    setImportantStyle(panelHost, "pointer-events", "none");
    pageLayout.clear();
    rootLayout.apply(panelMotion.value);
    panelMotion.to(0);
  }

  function togglePanel() {
    if (panelVisible) hidePanel();
    else showPanel();
  }

  function resolvedSelection() {
    return resolveRememberedSelection({
      current: readSelectedText(),
      previous: lastSelection,
      panelFocused: panelHasFocus() || Boolean(currentPicker),
    });
  }

  function currentSelection() {
    lastSelection = resolvedSelection();
    return lastSelection;
  }

  function contextSnapshot() {
    if (location.href !== identityUrl) {
      identityUrl = location.href;
      pageIdentity = createBridgeToken();
    }
    return {
      page: { ...readPageContext(), identity: pageIdentity },
      selection: currentSelection(),
      contextRevision,
    };
  }

  async function requestVisibleTabCapture() {
    if (document.visibilityState !== "visible") {
      throw new Error("目前分頁不在前景，請切回後重新擷取");
    }
    let timeout;
    let response;
    try {
      response = await Promise.race([
        browserApi.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Safari 擷取畫面逾時，請重新擷取")), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) throw new Error(response?.error || "無法擷取畫面");
    if (document.visibilityState !== "visible") {
      throw new Error("擷取期間分頁已切換，截圖已丟棄");
    }
    return response.dataUrl;
  }

  async function captureVisiblePage() {
    readingTools.suspend();
    clearReadingHighlights(document);
    panelMotion.finish();
    if (panelHost) setImportantStyle(panelHost, "display", "none");
    pageLayout.clear();
    try {
      await nextPaint();
      const before = captureLayout(document.documentElement);
      const dataUrl = await requestVisibleTabCapture();
      if (hasCaptureLayoutChanged(before, captureLayout(document.documentElement))) {
        throw new Error("頁面在擷取期間移動，請重新擷取");
      }
      return dataUrl;
    } finally {
      readingTools.resume();
      if (panelVisible) pageLayout.apply(panelWidth);
      if (panelHost) {
        setImportantStyle(panelHost, "display", panelVisible ? "block" : "none");
      }
    }
  }

  function inspectorLayer() {
    const host = document.createElement("div");
    const hostStyles = {
      all: "initial",
      position: "fixed",
      display: "block",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "auto",
      cursor: "crosshair",
      outline: "none",
    };
    for (const [property, value] of Object.entries(hostStyles)) {
      setImportantStyle(host, property, value);
    }
    host.tabIndex = -1;
    host.setAttribute("aria-label", "SafAI 網頁元素選取器");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box {
        position: fixed;
        box-sizing: border-box;
        border: 2px solid #007aff;
        border-radius: 12px;
        background: rgba(0, 122, 255, .1);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, .55), 0 10px 36px rgba(0, 0, 0, .12);
        transition: inset 55ms linear, width 55ms linear, height 55ms linear;
      }
      .tip {
        position: fixed;
        max-width: min(320px, calc(100vw - 24px));
        padding: 8px 11px;
        border: 1px solid rgba(255, 255, 255, .65);
        border-radius: 10px;
        background: rgba(245, 245, 247, .92);
        color: #1d1d1f;
        -webkit-backdrop-filter: blur(20px) saturate(160%);
        backdrop-filter: blur(20px) saturate(160%);
        box-shadow: 0 10px 32px rgba(0, 0, 0, .12);
        font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
        letter-spacing: .01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .hint {
        position: fixed;
        left: 50%;
        top: 18px;
        transform: translateX(-50%);
        padding: 9px 14px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, .65);
        background: rgba(245, 245, 247, .92);
        color: #1d1d1f;
        -webkit-backdrop-filter: blur(20px) saturate(160%);
        backdrop-filter: blur(20px) saturate(160%);
        box-shadow: 0 12px 32px rgba(0, 0, 0, .12);
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      }
      kbd { color: #007aff; font: inherit; }
      @media (prefers-color-scheme: dark) {
        .tip, .hint {
          background: rgba(38, 38, 40, .92);
          color: #f5f5f7;
          border-color: rgba(255, 255, 255, .16);
        }
        kbd { color: #64aaff; }
      }
      @media (prefers-reduced-transparency: reduce) {
        .tip, .hint { -webkit-backdrop-filter: none; backdrop-filter: none; background: #f5f5f7; }
      }
      @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
        .tip, .hint { background: #262628; }
      }
      @media (prefers-reduced-motion: reduce) {
        .box { transition: none; }
      }
    `;
    const box = document.createElement("div");
    box.className = "box";
    const tip = document.createElement("div");
    tip.className = "tip";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.innerHTML = "移動游標或按 Tab 選擇 · Enter 擷取 · <kbd>Esc</kbd> 取消";
    shadow.append(style, box, tip, hint);
    document.documentElement.append(host);
    return { host, box, tip };
  }

  function usableTarget(target) {
    let element = target;
    while (element && element !== document.documentElement) {
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.width > 2 && rect.height > 2) return element;
      element = element.parentElement;
    }
    return document.body;
  }

  function describeTarget(target) {
    return describeElementData({
      tagName: target.tagName,
      id: target.id,
      classes: Array.from(target.classList ?? []),
      ariaLabel: target.getAttribute?.("aria-label") || target.getAttribute?.("alt"),
      text: target.innerText || target.textContent,
      cssPath: cssPathFor(target),
    });
  }

  function keyboardCandidates() {
    const selector =
      "a[href], button, input, select, textarea, summary, h1, h2, h3, h4, h5, h6, img, picture, video, article, section, main, nav, aside, figure, li, p, [role], [aria-label], [tabindex]:not([tabindex='-1'])";
    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      if (element === panelHost || panelHost?.contains(element)) return false;
      if (element.disabled || element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rectIntersectsViewport(rect, { width: innerWidth, height: innerHeight });
    });
  }

  function pickElement() {
    if (currentPicker) return Promise.resolve({ cancelled: true });
    panelMotion.finish();
    const layer = inspectorLayer();
    setImportantStyle(panelHost, "display", "none");

    function elementBelowInspector(x, y) {
      setImportantStyle(layer.host, "pointer-events", "none");
      const element = document.elementFromPoint(x, y);
      setImportantStyle(layer.host, "pointer-events", "auto");
      return element;
    }

    let target = usableTarget(elementBelowInspector(innerWidth / 2, innerHeight / 2));
    let keyboardIndex = -1;
    let choosing = false;
    let cancelled = false;

    function renderTarget(nextTarget) {
      if (!nextTarget) return;
      target = usableTarget(nextTarget);
      const rect = target.getBoundingClientRect();
      Object.assign(layer.box.style, {
        left: `${Math.max(0, rect.left)}px`,
        top: `${Math.max(0, rect.top)}px`,
        width: `${Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))}px`,
        height: `${Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))}px`,
      });
      const meta = describeTarget(target);
      layer.tip.textContent = meta.element;
      layer.tip.style.left = `${Math.min(innerWidth - 180, Math.max(12, rect.left))}px`;
      layer.tip.style.top = `${Math.max(52, Math.min(innerHeight - 42, rect.top - 38))}px`;
    }

    function updateFromMouse(event) {
      const hit = elementBelowInspector(event.clientX, event.clientY);
      if (!hit || hit === layer.host || hit === panelHost) return;
      keyboardIndex = -1;
      renderTarget(hit);
    }

    renderTarget(target);

    return new Promise((resolve, reject) => {
      function cleanup() {
        layer.host.remove();
        setImportantStyle(panelHost, "display", panelVisible ? "block" : "none");
        document.removeEventListener("mousemove", updateFromMouse, true);
        document.removeEventListener("click", chooseFromMouse, true);
        document.removeEventListener("keydown", handlePickerKeydown, true);
        currentPicker = undefined;
        if (panelVisible) panelFrame?.focus({ preventScroll: true });
      }

      function cancel() {
        if (!currentPicker) return;
        cancelled = true;
        cleanup();
        resolve({ cancelled: true });
      }

      function handlePickerKeydown(event) {
        const action = pickerActionForKey(event.key, event.shiftKey);
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action.type === "cancel") cancel();
        else if (action.type === "confirm") chooseTarget(target);
        else navigate(action.direction);
      }

      function navigate(direction) {
        const candidates = keyboardCandidates();
        if (candidates.length === 0) return { ok: false };
        keyboardIndex = nextPickerIndex(keyboardIndex, direction, candidates.length);
        renderTarget(candidates[keyboardIndex]);
        return { ok: true, metadata: describeTarget(target) };
      }

      async function chooseTarget(selected) {
        if (choosing || !selected) return;
        choosing = true;
        try {
          const metadata = describeTarget(selected);
          setImportantStyle(layer.host, "display", "none");
          await nextPaint();
          if (cancelled) return;
          const before = captureLayout(selected);
          const screenshot = await requestVisibleTabCapture();
          if (cancelled) return;
          const after = captureLayout(selected);
          if (hasCaptureLayoutChanged(before, after)) {
            throw new Error("頁面在擷取期間移動，請重新選取元素");
          }
          const dataUrl = await cropScreenshot(
            screenshot,
            before.rect,
            before.viewport,
          );
          if (cancelled) return;
          cleanup();
          resolve({ cancelled: false, dataUrl, metadata });
        } catch (error) {
          if (cancelled) return;
          cleanup();
          reject(error);
        }
      }

      function chooseFromMouse(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const selected =
          target || usableTarget(elementBelowInspector(event.clientX, event.clientY));
        chooseTarget(selected);
      }

      currentPicker = {
        cancel,
        navigate,
        confirm: () => chooseTarget(target),
      };
      document.addEventListener("mousemove", updateFromMouse, true);
      document.addEventListener("click", chooseFromMouse, true);
      document.addEventListener("keydown", handlePickerKeydown, true);
      layer.host.focus({ preventScroll: true });
    });
  }

  async function handlePanelRequest(message) {
    switch (message.type) {
      case "CLOSE_PANEL":
        hidePanel();
        return { ok: true };
      case "REQUEST_CONTEXT":
        panelReady = true;
        {
          const quickAsk = pendingQuickAsk;
          pendingQuickAsk = undefined;
          return { ok: true, ...contextSnapshot(), quickAsk, readingPreferenceError };
        }
      case "PREPARE_LONG_CONTEXT":
        return { ok: true, plan: await longReader.prepare({ query: message.query, annotations: message.annotations, budgetChars: 32000, prefix: "P" }) };
      case "READ_LONG_BATCH":
        return { ok: true, batch: await longReader.readBatch({ snapshotId: message.snapshotId, index: message.index }) };
      case "VALIDATE_LONG_CONTEXT":
        return { ok: true, ...await longReader.validate({ snapshotId: message.snapshotId }) };
      case "RELEASE_LONG_CONTEXT":
        return { ok: true, ...await longReader.release({ snapshotId: message.snapshotId }) };
      case "SET_READING_PREFERENCES":
        if (typeof message.selectionTools !== "boolean") throw new Error("選取工具設定格式錯誤");
        readingTools.setEnabled(message.selectionTools);
        return { ok: true };
      case "CLEAR_SELECTION":
        readingTools.hide();
        lastSelection = "";
        window.getSelection()?.removeAllRanges();
        return { ok: true };
      case "LOCATE_SOURCE":
        panelMotion.finish();
        readingTools.hide();
        return locateQuote({ quote: message.quote, url: message.url }, document);
      case "CAPTURE_VIEWPORT":
        return { ok: true, dataUrl: await captureVisiblePage() };
      case "PICK_ELEMENT": {
        readingTools.suspend();
        clearReadingHighlights(document);
        try { const result = await pickElement(); return { ok: true, ...result }; }
        finally { readingTools.resume(); }
      }
      case "CANCEL_PICKER":
        currentPicker?.cancel();
        return { ok: true };
      case "PICKER_NAVIGATE":
        return currentPicker?.navigate(message.direction < 0 ? -1 : 1) ?? { ok: false };
      case "PICKER_CONFIRM":
        await currentPicker?.confirm();
        return { ok: true };
      default:
        return { ok: false, error: "未知操作" };
    }
  }

  function publishSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = resolvedSelection();
      if (selection === lastSelection) return;
      lastSelection = selection;
      postToPanel({ type: "SELECTION_CHANGED", selection });
    }, 120);
  }

  function isSafAiOwnedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return (
      node === panelHost ||
      node.id === "safai-extension-panel-host" ||
      node.id === PAGE_LAYOUT_STYLE_ID ||
      node.id === `${PAGE_LAYOUT_STYLE_ID}-site` ||
      node.hasAttribute?.("data-safai-reading-tools") ||
      node.hasAttribute?.("data-safai-reading-highlight") ||
      node.hasAttribute?.("data-safai-layout-probe") ||
      node.getAttribute?.("aria-label") === "SafAI 網頁元素選取器"
    );
  }

  function schedulePageInvalidation() {
    clearTimeout(contextInvalidationTimer);
    contextInvalidationTimer = setTimeout(() => {
      contextRevision += 1;
      postToPanel({ type: "PAGE_CONTEXT_INVALIDATED", contextRevision });
    }, 120);
  }

  const pageObserver = new MutationObserver((records) => {
    const pageChanged = records.some((record) => {
      if (isSafAiOwnedNode(record.target)) return false;
      if (record.type === "characterData") return true;
      const changedNodes = [...record.addedNodes, ...record.removedNodes];
      return changedNodes.length === 0 || changedNodes.some((node) => !isSafAiOwnedNode(node));
    });
    if (pageChanged) schedulePageInvalidation();
  });
  pageObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  setInterval(() => {
    if (location.href === lastObservedUrl) return;
    lastObservedUrl = location.href;
    schedulePageInvalidation();
  }, 1_000);

  document.addEventListener("selectionchange", publishSelection, true);
  document.addEventListener("select", publishSelection, true);
  window.addEventListener(
    "resize",
    () => {
      setPanelWidth(panelWidth);
    },
    { passive: true },
  );
  // This controller exists only in the extension's isolated world, not webpage scripts.
  // Publish after initialization succeeds so a failed setup never poisons retries.
  globalThis.__safaiTogglePanel = () => {
    togglePanel();
    return { ok: true, visible: panelVisible };
  };
}

runContentBridge();
