import { createDocumentIndex, MAX_DOCUMENT_CHARS } from "./long-document.js";

const SOURCE_CHARS = 1200;
const MAX_BUDGET_TOKENS = MAX_DOCUMENT_CHARS * 4;

// This deliberately estimates rather than emulates any provider tokenizer.
// English/number/space runs are charged at one token per three characters,
// ASCII punctuation at one token each, CJK and other BMP text at two, and
// non-BMP code points (including emoji) at four. Callers must estimate the
// serialized request too: this function knows nothing about message framing.
export function estimateTokens(value) {
  if (typeof value !== "string") throw new TypeError("Token estimation requires a string.");
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun) tokens += Math.ceil(asciiRun / 3);
    asciiRun = 0;
  };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 32 || (code >= 9 && code <= 13)) {
      asciiRun += 1;
      continue;
    }
    flushAscii();
    if (code <= 0x7f) tokens += 1;
    else if (code >= 0xd800 && code <= 0xdbff &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      tokens += 4;
      index++;
    } else tokens += 2;
  }
  flushAscii();
  return tokens;
}

function safePrefix(prefix) {
  if (typeof prefix !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(prefix)) throw new Error("來源識別格式不正確。");
  return prefix;
}

function safeBudget(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BUDGET_TOKENS) throw new Error("內容 token 額度超出上限。");
  return value;
}

function boundary(text, offset, side) {
  let value = Math.max(0, Math.min(text.length, offset));
  if (value > 0 && value < text.length && /[\uD800-\uDBFF]/.test(text[value - 1]) && /[\uDC00-\uDFFF]/.test(text[value])) {
    value += side === "end" ? 1 : -1;
  }
  return value;
}

function annotationText(item) {
  return typeof item === "string" ? item : item?.text ?? item?.quote ?? "";
}

function locate(text, value) {
  if (typeof value !== "string") return { start: -1, ambiguous: false };
  const needle = value.replace(/\s+/gu, " ").trim();
  if (!needle) return { start: -1, ambiguous: false };
  const start = text.indexOf(needle);
  return { start, length: needle.length, ambiguous: start >= 0 && text.indexOf(needle, start + 1) >= 0 };
}

function centeredRange(text, anchor, budgetTokens) {
  if (!budgetTokens || !text.length) return { start: anchor, end: anchor };
  // The cheapest text costs one token per three UTF-16 units. No fitting
  // range can be longer, so binary search never needs to rescan huge slices.
  const maxChars = budgetTokens * 3;
  let low = 0;
  let high = Math.min(maxChars, Math.max(anchor, text.length - anchor));
  let best = { start: anchor, end: anchor };
  while (low <= high) {
    const radius = Math.floor((low + high) / 2);
    const candidate = {
      start: boundary(text, anchor - radius, "start"),
      end: boundary(text, anchor + radius, "end"),
    };
    if (estimateTokens(text.slice(candidate.start, candidate.end)) <= budgetTokens) {
      best = candidate;
      low = radius + 1;
    } else high = radius - 1;
  }

  // Once a centered window reaches an edge, spend the remaining allowance on
  // the other side rather than leaving usable context behind.
  if (best.start === 0 && best.end < text.length) {
    let left = best.end;
    let right = Math.min(text.length, maxChars);
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const end = boundary(text, middle, "end");
      if (estimateTokens(text.slice(0, end)) <= budgetTokens) {
        best.end = end;
        left = middle + 1;
      } else right = middle - 1;
    }
  } else if (best.end === text.length && best.start > 0) {
    let left = Math.max(0, text.length - maxChars);
    let right = best.start;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const start = boundary(text, middle, "start");
      if (estimateTokens(text.slice(start)) <= budgetTokens) {
        best.start = start;
        right = middle - 1;
      } else left = middle + 1;
    }
  }
  return best;
}

function source(index, start, end, id) {
  return { id, quote: index.text.slice(start, end), url: index.url, title: index.title, start, end };
}

function sourcesFor(index, range, prefix) {
  const sources = [];
  for (let start = range.start; start < range.end;) {
    // Move a split surrogate boundary inward so the quote remains within the
    // locator's hard 1,200 UTF-16-unit allowance.
    const end = boundary(index.text, Math.min(range.end, start + SOURCE_CHARS), "start");
    sources.push(source(index, start, end, `${prefix}R${start}`));
    start = end;
  }
  return sources;
}

export function selectCenteredContext(documentIndexOrPage, {
  budgetTokens,
  annotations = [],
  anchorSelection = "",
  anchorOffset,
  prefix = "P",
} = {}) {
  safeBudget(budgetTokens);
  safePrefix(prefix);
  if (!Array.isArray(annotations) || annotations.length > 10) throw new Error("最多保留 10 段標註。");
  const marks = annotations.map(annotationText);
  if (marks.some(mark => typeof mark !== "string") || marks.reduce((total, mark) => total + mark.length, 0) > 16_000) throw new Error("標註超過 16,000 字元上限。");
  const index = documentIndexOrPage?.chunks && typeof documentIndexOrPage?.totalChars === "number"
    ? documentIndexOrPage
    : createDocumentIndex(documentIndexOrPage);

  let missingAnnotations = 0;
  let ambiguousAnnotations = 0;
  let annotationAnchor;
  for (const mark of marks) {
    const found = locate(index.text, mark);
    if (found.start < 0) missingAnnotations += 1;
    else {
      if (found.ambiguous) ambiguousAnnotations += 1;
      annotationAnchor ??= found.start + Math.floor(found.length / 2);
    }
  }

  const selection = locate(index.text, anchorSelection);
  let anchor;
  if (anchorOffset !== undefined) {
    if (!Number.isSafeInteger(anchorOffset)) throw new Error("內容定位格式不正確。");
    anchor = Math.max(0, Math.min(index.totalChars, anchorOffset));
  } else if (selection.start >= 0) anchor = selection.start + Math.floor(selection.length / 2);
  else if (annotationAnchor !== undefined) anchor = annotationAnchor;
  else anchor = Math.floor(index.totalChars / 2);
  anchor = boundary(index.text, anchor, "start");

  const complete = estimateTokens(index.text) <= budgetTokens;
  const range = complete ? { start: 0, end: index.totalChars } : centeredRange(index.text, anchor, budgetTokens);
  const selectedChars = range.end - range.start;
  const ranges = selectedChars ? [range] : [];
  return {
    sources: sourcesFor(index, range, prefix),
    outline: index.outline,
    coverage: {
      strategy: "centered",
      totalChars: index.totalChars,
      selectedChars,
      estimatedTokens: estimateTokens(index.text.slice(range.start, range.end)),
      complete,
      ranges,
      anchorOffset: anchor,
      missingAnnotations,
      ambiguousAnnotations,
    },
  };
}
