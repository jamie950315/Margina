import { compactText } from "../core/page-context.js";

const MAX_SELECTION_CHARS = 16_000;

export function sanitizePageUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return compactText(url.toString(), 4_096);
}

function capSelection(value) {
  const selection = String(value ?? "").trim();
  if (selection.length <= MAX_SELECTION_CHARS) return selection;
  return `${selection.slice(0, MAX_SELECTION_CHARS - 1)}…`;
}

function deepestActiveElement(root) {
  let active = root?.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

export function resolveRememberedSelection({ current, previous, panelFocused }) {
  if (current) return current;
  return panelFocused ? previous : "";
}

export function readSelectedText(documentObject = document, windowObject = window) {
  const active = deepestActiveElement(documentObject);
  if (active?.tagName === "INPUT" && active.type === "password") return "";
  const pageSelection = capSelection(windowObject.getSelection?.()?.toString());
  if (pageSelection) return pageSelection;

  const tagName = active?.tagName?.toUpperCase();
  if (
    (tagName === "INPUT" || tagName === "TEXTAREA") &&
    Number.isInteger(active.selectionStart) &&
    Number.isInteger(active.selectionEnd) &&
    active.selectionEnd > active.selectionStart
  ) {
    return capSelection(
      String(active.value ?? "").slice(active.selectionStart, active.selectionEnd),
    );
  }

  return "";
}

export function readPageContext(documentObject = document) {
  const readableRoot =
    documentObject.querySelector?.("main, article, [role='main']") ?? documentObject.body;
  const sourceText = readableRoot?.innerText ?? readableRoot?.textContent ?? "";
  const normalizedText = compactText(sourceText, Infinity);

  return {
    title: compactText(documentObject.title, 512),
    url: sanitizePageUrl(documentObject.location?.href),
    text: compactText(normalizedText, 32_000),
    truncated: normalizedText.length > 32_000,
    originalChars: normalizedText.length,
  };
}

function safeIdentifier(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 120)
    .replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function siblingIndex(element) {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function pathSegment(element) {
  const tag = String(element.tagName ?? "element").toLowerCase();
  if (element.id) return `${tag}#${safeIdentifier(element.id)}`;

  const classes = Array.from(element.classList ?? [])
    .filter(Boolean)
    .slice(0, 2)
    .map((name) => `.${safeIdentifier(name)}`)
    .join("");
  if (classes) return `${tag}${classes}`;

  const index = siblingIndex(element);
  return index > 1 ? `${tag}:nth-of-type(${index})` : tag;
}

export function cssPathFor(element) {
  if (!element || element.nodeType !== 1) return "";

  const segments = [];
  let current = element;
  while (current && current.nodeType === 1 && segments.length < 6) {
    segments.unshift(pathSegment(current));
    if (current.id) break;
    current = current.parentElement;
  }
  return segments.join(" > ");
}
