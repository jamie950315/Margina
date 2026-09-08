export const MAX_ANNOTATIONS = 10;
export const MAX_ANNOTATION_CHARS = 16_000;

export function collectAnnotations(saved = [], current = "") {
  const result = [];
  const seen = new Set();
  let total = 0;
  for (const value of [...saved, current]) {
    if (typeof value !== "string") throw new TypeError("標註內容格式錯誤");
    const text = value.trim();
    const key = text.replace(/\s+/gu, " ");
    if (!text || seen.has(key)) continue;
    if (result.length >= MAX_ANNOTATIONS) throw new Error("最多保留 10 段標註，請先移除不需要的段落");
    total += text.length;
    if (total > MAX_ANNOTATION_CHARS) throw new Error("標註總長超過 16,000 字，請縮短或移除部分段落");
    seen.add(key);
    result.push(text);
  }
  return result;
}
