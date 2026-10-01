import { t } from "../i18n/index.js";
const MAX_CHARS = 2_000_000;
const EXCLUDED = "script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],#safai-extension-panel-host,[data-safai-host],[data-safai-reading-tools],[data-safai-reading-highlight]";
const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DIV|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|P|PRE|SECTION|TABLE|TD|TH|TR|UL|OL)$/;

// Walk visible document text without cloning the page or copying extension UI.
// Bound work as well as output: an extreme whitespace/node flood fails explicitly.
export function documentText(doc, headings, textNodes, root = doc.querySelector("main, article, [role='main']") ?? doc.body) {
  if (!root) throw new Error(t("網頁沒有可讀取的文字"));
  const pieces = [];
  let chars = 0;
  let visited = 0;
  let rawChars = 0;
  function visit(node) {
    if (++visited > 500_000) throw new Error(t("網頁結構過大，無法完整讀取"));
    if (node.nodeType === 3) {
      rawChars += node.data.length;
      if (rawChars > 8_000_000) throw new Error(t("網頁文字過大，無法完整讀取"));
      const value = node.data.replace(/\s+/g, " ");
      chars += value.length;
      if (chars > MAX_CHARS) throw new Error(t("網頁超過兩百萬字，請改用較小的文章範圍"));
      pieces.push(value);
      if (textNodes) textNodes.push({ node, value });
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
  if (!text) throw new Error(t("網頁沒有可讀取的文字"));
  if (text.length > MAX_CHARS) throw new Error(t("網頁超過兩百萬字，請改用較小的文章範圍"));
  if (textNodes) {
    let cursor = 0;
    for (const record of textNodes) {
      const needle = record.value.trim();
      if (!needle) {
        record.start = cursor;
        record.end = cursor;
        continue;
      }
      const start = text.indexOf(needle, cursor);
      record.start = start < 0 ? cursor : start;
      record.end = Math.min(text.length, record.start + needle.length);
      cursor = record.end;
    }
  }
  return text;
}
