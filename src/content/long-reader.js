import { createDocumentIndex, selectDocumentContext, documentBatches } from "../core/long-document.js";
import { selectCenteredContext } from "../core/context-budget.js";
import { sanitizePageUrl } from "./page-reader.js";

import { documentText } from "./document-text.js";
function normalizedSelection(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function nodeOffset(record, rawOffset) {
  const prefix = record.node.data.slice(0, Math.max(0, rawOffset)).replace(/\s+/gu, " ").trimStart();
  return Math.min(record.end, record.start + prefix.length);
}

function liveSelectionAnchor(doc, textNodes, anchorSelection) {
  const selection = doc.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return undefined;
  const selected = normalizedSelection(selection.toString());
  const expected = normalizedSelection(anchorSelection);
  if (!selected || (expected && selected !== expected)) return undefined;
  const range = selection.getRangeAt(0);
  const start = textNodes.find(record => record.node === range.startContainer);
  const end = textNodes.find(record => record.node === range.endContainer);
  if (!start && !end) return undefined;
  const startOffset = start ? nodeOffset(start, range.startOffset) : end.start;
  const endOffset = end ? nodeOffset(end, range.endOffset) : start.end;
  return Math.floor((Math.min(startOffset, endOffset) + Math.max(startOffset, endOffset)) / 2);
}

function rectDistance(rect, x, y) {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function viewportAnchor(doc, textNodes, totalChars) {
  const view = doc.defaultView;
  const viewportWidth = Math.max(0, Number(view?.innerWidth) || 0);
  const rootRect = doc.documentElement?.getBoundingClientRect?.();
  const rootLeft = Math.max(0, Number(rootRect?.left) || 0);
  const rootRight = Math.min(viewportWidth, Number(rootRect?.right) || 0);
  const x = rootRight > rootLeft ? (rootLeft + rootRight) / 2 : viewportWidth / 2;
  const y = Math.max(0, Number(view?.innerHeight) || 0) / 2;
  const direct = doc.caretRangeFromPoint?.(x, y);
  const directRecord = direct && textNodes.find(record => record.node === direct.startContainer);
  if (directRecord) return nodeOffset(directRecord, direct.startOffset);

  // Geometry work is node-bounded and evenly sampled for extreme documents;
  // no per-character offset or rectangle table is retained.
  const limit = 20_000;
  const stride = Math.max(1, Math.ceil(textNodes.length / limit));
  const range = doc.createRange?.();
  let best;
  for (let index = 0; range && index < textNodes.length; index += stride) {
    const record = textNodes[index];
    if (record.end <= record.start) continue;
    range.selectNodeContents(record.node);
    const rects = typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : [];
    if (!rects.length && typeof range.getBoundingClientRect === "function") rects.push(range.getBoundingClientRect());
    for (const rect of rects) {
      if (!rect || !(rect.width > 0 || rect.height > 0)) continue;
      const distance = rectDistance(rect, x, y);
      if (!best || distance < best.distance) best = { distance, offset: Math.floor((record.start + record.end) / 2) };
    }
  }
  range?.detach?.();
  return best?.offset ?? Math.floor(totalChars / 2);
}

export function createLongReader(doc = document) {
  let snapshot = null;
  function validate({ snapshotId } = {}) {
    if (!snapshot || snapshotId !== snapshot.id) throw new Error("長文快照已變更，請重新讀取後再傳送");
    if (doc.location.href !== snapshot.rawUrl ||
        documentText(doc) !== snapshot.document.text) {
      snapshot = null;
      throw new Error("網頁內容已變更，請重新讀取後再傳送");
    }
    return { ok: true };
  }
  return {
    prepare({ query = "", annotations = [], budgetChars = 32_000, prefix = "P", strategy = "relevant", budgetTokens, anchorSelection = "" } = {}) {
      snapshot = null;
      const headings = [];
      const textNodes = strategy === "centered" ? [] : undefined;
      const text = documentText(doc, headings, textNodes);
      const page = { text, headings, title: String(doc.title ?? "").slice(0, 512), url: sanitizePageUrl(doc.location.href) };
      const indexed = createDocumentIndex(page);
      let context;
      if (strategy === "centered") {
        let anchorOffset = liveSelectionAnchor(doc, textNodes, anchorSelection);
        const currentAnchor = normalizedSelection(anchorSelection);
        if (anchorOffset === undefined && !(currentAnchor && text.includes(currentAnchor))) {
          anchorOffset = viewportAnchor(doc, textNodes, indexed.totalChars);
        }
        context = selectCenteredContext(indexed, { budgetTokens, annotations, anchorSelection, anchorOffset, prefix });
      } else {
        context = selectDocumentContext(indexed, { query, annotations, budgetChars, prefix });
      }
      const batches = documentBatches(indexed, { prefix });
      const random = new Uint32Array(4);
      doc.defaultView.crypto.getRandomValues(random);
      const id = Array.from(random, value => value.toString(16).padStart(8, "0")).join("");
      snapshot = { id, rawUrl: doc.location.href, document: indexed, batches };
      return { snapshotId: id, title: indexed.title, url: indexed.url, totalChars: indexed.totalChars, batchCount: batches.length, context };
    },
    readBatch({ snapshotId, index } = {}) {
      validate({ snapshotId });
      if (!Number.isInteger(index) || index < 0 || index >= snapshot.batches.length) throw new Error("長文段落編號無效");
      const batch = snapshot.batches[index];
      return { ...batch, snapshotId, totalChars: snapshot.document.totalChars };
    },
    validate,
    release({ snapshotId } = {}) {
      if (snapshot?.id === snapshotId) snapshot = null;
      return { ok: true };
    },
  };
}
