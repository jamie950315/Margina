import { t } from "../i18n/index.js";
import { readSelectedText, sanitizePageUrl } from "./page-reader.js";
import { documentText } from "./document-text.js";

const excluded = "input,textarea,select,[contenteditable]:not([contenteditable='false']),script,style,noscript,[hidden],[aria-hidden='true']";
const normalize = value => String(value ?? "").replace(/\s+/gu, " ").trim();
const elementFor = node => node?.nodeType === 1 ? node : node?.parentElement;
const readingHighlights = new WeakMap();

function rangeIncludesExcludedContent(range, doc) {
  const root = range.commonAncestorContainer;
  if (root.nodeType !== 1) return false;
  const filter = doc.defaultView.NodeFilter;
  // Inspect only intersecting subtrees. Cloning a selection could duplicate a
  // whole article DOM on every mouseup/keyup just to find an excluded field.
  const walker = doc.createTreeWalker(root, filter.SHOW_ELEMENT, {
    acceptNode(element) {
      if (!range.intersectsNode(element)) return filter.FILTER_REJECT;
      return element.matches(excluded) ? filter.FILTER_ACCEPT : filter.FILTER_SKIP;
    },
  });
  return Boolean(walker.nextNode());
}

export function clearReadingHighlights(documentObject = document) {
  readingHighlights.get(documentObject)?.();
}

export function createReadingTools({ document: doc, window: win, onAsk, enabled = true }) {
  const host = doc.createElement("div");
  host.dataset.safaiReadingTools = "";
  host.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483647!important;width:max-content!important;max-width:calc(100vw - 8px)!important;display:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = `:host{color-scheme:light dark}nav{box-sizing:border-box;display:flex;flex-wrap:wrap;max-width:100%;gap:2px;padding:4px;border:1px solid #89949766;border-radius:12px;background:#f3f5f5f5;color:#253033;box-shadow:0 5px 24px #0003;font:12px -apple-system,BlinkMacSystemFont,sans-serif}button{appearance:none;border:0;border-radius:8px;background:transparent;color:inherit;padding:8px 9px;font:inherit;white-space:nowrap;cursor:pointer}button:hover,button:focus-visible{background:#83959830;outline:2px solid #63898e;outline-offset:-2px}@media(prefers-color-scheme:dark){nav{background:#232b2ff5;color:#edf1f2}}`;
  const nav = doc.createElement("nav");
  const controls = [];
  function updateLanguage() {
    nav.setAttribute("aria-label", t("Margina 選取文字工具"));
    for (const [button, label] of controls) button.textContent = t(label);
  }
  let selected = "";
  let destroyed = false;
  let suspended = 0;
  let returnFocus = null;
  const hide = () => { host.style.setProperty("display", "none", "important"); selected = ""; };
  for (const [label, prompt] of [["解釋", "請用白話解釋以下選取文字。"], ["翻譯", "請將以下選取文字翻譯成繁體中文。"], ["整理", "請整理以下選取文字的重點。"], ["追問", "我想針對以下選取文字提問："]]) {
    const button = doc.createElement("button");
    button.type = "button";
    controls.push([button, label]);
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => {
      const selection = selected;
      hide();
      if (selection && enabled && !destroyed) onAsk({ prompt: t(prompt), selection });
    });
    nav.append(button);
  }
  updateLanguage();
  shadow.append(style, nav);
  doc.documentElement.append(host);
  const update = () => {
    if (!enabled || destroyed || suspended) return hide();
    const selection = win.getSelection?.();
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active === host) return;
    if (active?.closest?.(excluded) || elementFor(selection?.anchorNode)?.closest?.(excluded) || elementFor(selection?.focusNode)?.closest?.(excluded) || !selection?.rangeCount || selection.isCollapsed) return hide();
    const range = selection.getRangeAt(0);
    if (rangeIncludesExcludedContent(range, doc)) return hide();
    selected = readSelectedText(doc, win);
    if (!selected) return hide();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height || rect.bottom < 0 || rect.top > win.innerHeight) return hide();
    host.style.setProperty("display", "block", "important");
    const width = host.getBoundingClientRect().width || 232;
    const height = host.getBoundingClientRect().height || 42;
    host.style.setProperty("left", `${Math.max(4, Math.min(rect.left, win.innerWidth - width - 4))}px`, "important");
    host.style.setProperty("top", `${Math.max(4, Math.min(rect.top >= height + 8 ? rect.top - height - 8 : rect.bottom + 8, win.innerHeight - height - 4))}px`, "important");
  };
  const keydown = event => {
    if (event.key === "Escape") {
      const focused = doc.activeElement === host;
      hide();
      if (focused) { shadow.activeElement?.blur(); returnFocus?.focus?.({ preventScroll: true }); }
      returnFocus = null;
    } else if (event.key === "Tab" && !event.shiftKey && selected && host.style.display !== "none" && doc.activeElement !== host) {
      event.preventDefault();
      returnFocus = doc.activeElement;
      nav.querySelector("button").focus({ preventScroll: true });
    }
  };
  const keyup = event => { if (event.key !== "Escape" && event.key !== "Tab") update(); };
  const changed = () => { if (!win.getSelection?.()?.toString()) hide(); };
  doc.addEventListener("mouseup", update);
  doc.addEventListener("keyup", keyup);
  doc.addEventListener("keydown", keydown);
  doc.addEventListener("selectionchange", changed);
  doc.addEventListener("scroll", hide, true);
  win.addEventListener("resize", hide);
  return { hide, updateLanguage, suspend() { suspended += 1; hide(); }, resume() { suspended = Math.max(0, suspended - 1); }, setEnabled(value) { enabled = Boolean(value); if (!enabled) hide(); }, destroy() {
    destroyed = true;
    hide();
    doc.removeEventListener("mouseup", update);
    doc.removeEventListener("keyup", keyup);
    doc.removeEventListener("keydown", keydown);
    doc.removeEventListener("selectionchange", changed);
    doc.removeEventListener("scroll", hide, true);
    win.removeEventListener("resize", hide);
    host.remove();
  } };
}

export function locateQuote({ quote, url }, documentObject = document) {
  const doc = documentObject;
  const win = doc.defaultView;
  let samePage = false;
  try { samePage = /^https?:/u.test(url) && sanitizePageUrl(url) === sanitizePageUrl(doc.location.href); } catch { /* A stale or invalid source cannot be located. */ }
  if (!samePage) throw new Error(t("來源頁面已變更，請重新讀取頁面。"));
  const needle = normalize(quote);
  if (!needle || needle.length > 1200) throw new Error(t("找不到原文，請重新讀取頁面。"));
  const segments = [];
  // Citations must use the exact whitespace/block rules used to prepare API
  // sources. Scan the body to preserve rejection of duplicates outside main.
  const text = documentText(doc, undefined, segments, doc.body);
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(t("找不到原文，內容可能已更新，請重新讀取頁面。"));
  if (text.indexOf(needle, index + 1) >= 0) throw new Error(t("原文出現於多處，無法確定引用位置。"));
  // Keep one offset record per text node, not one object per character. Only
  // after a unique match exists do we map its two endpoints back to raw text.
  const positionAt = target => {
    const segment = segments.find(item => item.start <= target && item.end > target);
    if (!segment) return null;
    let normalizedOffset = segment.start;
    let space = true;
    for (let offset = 0; offset < segment.node.data.length; offset += 1) {
      const whitespace = /\s/u.test(segment.node.data[offset]);
      if (whitespace && space) continue;
      space = whitespace;
      if (normalizedOffset === target) return { node: segment.node, offset };
      normalizedOffset += 1;
    }
    return null;
  };
  const start = positionAt(index);
  const end = positionAt(index + needle.length - 1);
  if (!start || !end) throw new Error(t("找不到原文，請重新讀取頁面。"));
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  clearReadingHighlights(doc);
  start.node.parentElement.scrollIntoView?.({ block: "center", behavior: "auto" });
  // A closed-shadow overlay highlights the exact range without rewriting page nodes/styles.
  const host = doc.createElement("div");
  host.dataset.safaiReadingHighlight = "";
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483646!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const paint = () => {
    shadow.replaceChildren();
    for (const rect of Array.from(range.getClientRects?.() ?? []).slice(0, 100)) {
      const mark = doc.createElement("div");
      mark.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#e7bb4044;outline:1px solid #c69824;border-radius:3px;pointer-events:none;`;
      shadow.append(mark);
    }
  };
  paint();
  doc.documentElement.append(host);
  const clear = () => { host.remove(); win.clearTimeout(timer); doc.removeEventListener("scroll", paint, true); win.removeEventListener("resize", paint); readingHighlights.delete(doc); };
  const timer = win.setTimeout(clear, 2200);
  readingHighlights.set(doc, clear);
  doc.addEventListener("scroll", paint, true);
  win.addEventListener("resize", paint);
  return { ok: true };
}
