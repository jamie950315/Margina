import { compactText } from "./page-context.js";

export function sourcesForPage(page, { prefix = "P", maxSources = 32 } = {}) {
  const limit = Number.isFinite(maxSources) ? Math.max(0, Math.min(32, Math.floor(maxSources))) : 32;
  let url;
  try {
    const parsed = new URL(page?.url);
    if (!["https:", "http:"].includes(parsed.protocol)) return [];
    parsed.username = parsed.password = parsed.search = parsed.hash = "";
    url = parsed.href.slice(0, 4096);
  } catch { return []; }
  const safePrefix = /^[A-Z][A-Z0-9]{0,7}$/.test(prefix) ? prefix : "P";
  const title = compactText(page?.title, 512);
  const sources = [];
  // Excerpts partition the bounded page text, never multiply it per citation.
  const text = String(page?.text ?? "").slice(0, 32_000);
  if (!text.trim()) return [];
  for (let offset = 0; offset < text.length && sources.length < limit;) {
    let end = Math.min(offset + 1200, text.length);
    // Do not split an emoji's UTF-16 pair across two independently rendered excerpts.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
    const quote = text.slice(offset, end);
    sources.push({ id: `${safePrefix}${sources.length + 1}`, quote, url, title });
    offset = end;
  }
  return sources;
}
