import { createDocumentIndex, selectDocumentContext, documentBatches } from "../core/long-document.js";
import { sanitizePageUrl } from "./page-reader.js";

const MAX_CHARS = 2_000_000;
const EXCLUDED = "script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],#safai-extension-panel-host,[data-safai-host],[data-safai-reading-tools],[data-safai-reading-highlight]";
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DIV|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|P|PRE|SECTION|TABLE|TD|TH|TR|UL|OL)$/;

// Walk visible document text without cloning the page or copying extension UI.
// Bound work as well as output: an extreme whitespace/node flood fails explicitly.
function documentText(doc, headings) {
  const root = doc.querySelector("main, article, [role='main']") ?? doc.body;
  if (!root) throw new Error("網頁沒有可讀取的文字");
  const pieces = [];
  let chars = 0;
  let visited = 0;
  let rawChars = 0;
  function visit(node) {
    if (++visited > 500_000) throw new Error("網頁結構過大，無法完整讀取");
    if (node.nodeType === 3) {
      rawChars += node.data.length;
      if (rawChars > 8_000_000) throw new Error("網頁文字過大，無法完整讀取");
      const value = node.data.replace(/\s+/g, " ");
      chars += value.length;
      if (chars > MAX_CHARS) throw new Error("網頁超過兩百萬字，請改用較小的文章範圍");
      pieces.push(value);
      return;
    }
    if (node.nodeType !== 1 || node.matches(EXCLUDED)) return;
    const style = doc.defaultView?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden") return;
    const block = BLOCK.test(node.tagName) || /^(block|flex|grid|table|list-item)/.test(style?.display ?? "");
    if (block) pieces.push(" ");
    const headingStart = headings && headings.length < 80 && /^H[1-6]$/.test(node.tagName) ? pieces.length : null;
    for (const child of node.childNodes) visit(child);
    if (headingStart !== null) headings.push(pieces.slice(headingStart).join("").replace(/\s+/g, " ").trim().slice(0, 120));
    if (block) pieces.push(" ");
  }
  visit(root);
  const text = pieces.join("").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("網頁沒有可讀取的文字");
  if (text.length > MAX_CHARS) throw new Error("網頁超過兩百萬字，請改用較小的文章範圍");
  return text;
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
    prepare({ query = "", annotations = [], budgetChars = 32_000, prefix = "P" } = {}) {
      snapshot = null;
      const headings = [];
      const text = documentText(doc, headings);
      const page = { text, headings, title: String(doc.title ?? "").slice(0, 512), url: sanitizePageUrl(doc.location.href) };
      const indexed = createDocumentIndex(page);
      const context = selectDocumentContext(indexed, { query, annotations, budgetChars, prefix });
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
