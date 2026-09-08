// Ephemeral, local-only indexing. Offsets refer to the exact reader text (UTF-16).
export const MAX_DOCUMENT_CHARS = 2_000_000;
export const CHUNK_CHARS = 1200;
const NEIGHBOR_CHARS = 300;

function boundary(text, offset, outward = false) {
  const value = Math.max(0, Math.min(text.length, offset));
  if (value > 0 && value < text.length && /[\uD800-\uDBFF]/.test(text[value - 1]) && /[\uDC00-\uDFFF]/.test(text[value])) return value + (outward ? 1 : -1);
  return value;
}

function positiveSize(value, minimum = 2) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_DOCUMENT_CHARS) throw new Error('長文處理大小超出上限。');
  return value;
}

function safePrefix(prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(prefix)) throw new Error('來源識別格式不正確。');
  return prefix;
}

function partition(text, start, end) {
  const ranges = [];
  while (start < end) {
    const next = boundary(text, Math.min(start + CHUNK_CHARS, end));
    ranges.push({ start, end: next });
    start = next;
  }
  return ranges;
}

function merged(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

function size(ranges) { return ranges.reduce((total, range) => total + range.end - range.start, 0); }

function source(index, range, id) {
  return { id, quote: index.text.slice(range.start, range.end), url: index.url, title: index.title, start: range.start, end: range.end };
}

export function createDocumentIndex(page) {
  if (typeof page?.text !== 'string' || !page.text.trim()) throw new Error('無法讀取頁面正文。');
  if (page.text.length > MAX_DOCUMENT_CHARS) throw new Error('頁面超過長文處理的 2,000,000 字元上限，請縮小閱讀範圍。');
  if (page.truncated || (Number.isFinite(page.originalChars) && page.originalChars > page.text.length)) throw new Error('未取得完整頁面，請重新讀取後再處理長文。');
  const text = page.text;
  const title = typeof page.title === 'string' ? page.title.slice(0, 300) : '';
  const url = typeof page.url === 'string' ? page.url.slice(0, 4096) : '';
  const headings = Array.isArray(page.headings) ? page.headings.slice(0, 80).map(item => typeof item === 'string' ? item : item?.text).filter(item => typeof item === 'string').map(item => item.slice(0, 120)) : [];
  return {
    text, title, url, totalChars: text.length,
    outline: [title, ...headings].filter(Boolean).join('\n').slice(0, 2400),
    chunks: partition(text, 0, text.length).map((range, index) => ({ index, ...range, quote: text.slice(range.start, range.end) })),
  };
}

function termsFor(query) {
  const text = String(query || '').slice(0, 512).toLocaleLowerCase();
  const terms = new Set(text.match(/[\p{L}\p{N}]+/gu) || []);
  // CJK has no whitespace-delimited words. Bigrams provide a bounded lexical
  // retrieval signal without requiring Safari-incompatible segmenter APIs.
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []) {
    const chars = Array.from(run);
    for (let i = 0; i < chars.length - 1; i += 1) terms.add(chars[i] + chars[i + 1]);
  }
  return [...terms].filter(term => term.length > 1).slice(0, 128);
}

export function selectDocumentContext(index, { query = '', annotations = [], budgetChars = 32000, prefix = 'P' } = {}) {
  positiveSize(budgetChars);
  safePrefix(prefix);
  if (!Array.isArray(annotations) || annotations.length > 10) throw new Error('最多保留 10 段標註。');
  const marks = annotations.map(item => typeof item === 'string' ? item : item?.text ?? item?.quote ?? '');
  if (marks.some(mark => typeof mark !== 'string') || marks.reduce((total, mark) => total + mark.length, 0) > 16000) throw new Error('標註超過 16,000 字元上限。');
  let missingAnnotations = 0;
  let ambiguousAnnotations = 0;
  let ranges = [];
  for (const mark of marks) {
    const needle = mark && index.text.includes(mark) ? mark : mark.replace(/\s+/gu, " ").trim();
    const start = needle ? index.text.indexOf(needle) : -1;
    if (start < 0) { missingAnnotations += 1; continue; }
    if (index.text.indexOf(needle, start + 1) >= 0) { ambiguousAnnotations += 1; continue; }
    ranges.push({ start: boundary(index.text, start - NEIGHBOR_CHARS), end: boundary(index.text, start + needle.length + NEIGHBOR_CHARS, true) });
  }
  ranges = merged(ranges);
  if (size(ranges) > budgetChars) throw new Error('閱讀額度不足以保留所有標註與前後文，請減少標註或增加閱讀額度。');

  // Add only the uncovered portion of a candidate; even partial final chunks
  // remain exact source ranges and never exceed the total character allowance.
  function add(range) {
    let remaining = budgetChars - size(ranges);
    if (remaining <= 0) return;
    let pieces = [{ start: range.start, end: range.end }];
    for (const used of ranges) {
      pieces = pieces.flatMap(piece => {
        if (used.end <= piece.start || used.start >= piece.end) return [piece];
        return [
          ...(used.start > piece.start ? [{ start: piece.start, end: used.start }] : []),
          ...(used.end < piece.end ? [{ start: used.end, end: piece.end }] : []),
        ];
      });
    }
    for (const piece of pieces) {
      const end = boundary(index.text, Math.min(piece.end, piece.start + remaining));
      if (end <= piece.start) continue;
      ranges.push({ start: piece.start, end });
      remaining -= end - piece.start;
    }
    ranges = merged(ranges);
  }

  const terms = termsFor(query);
  const overlap = Math.min(512, Math.max(0, ...terms.map(term => term.length)));
  const frequency = terms.map(() => 0);
  const matches = index.chunks.map(chunk => {
    const lower = index.text.slice(Math.max(0, chunk.start - overlap), Math.min(index.totalChars, chunk.end + overlap)).toLocaleLowerCase();
    const hits = terms.map((term, position) => {
      const hit = lower.includes(term);
      if (hit) frequency[position] += 1;
      return hit;
    });
    return { chunk, hits };
  });
  // Equal/no lexical evidence must not collapse back to a head-only cutoff.
  // Breadth-first midpoint order spreads tied candidates across the document.
  const spreadRank = [];
  const intervals = [[0, index.chunks.length - 1]];
  for (let cursor = 0; cursor < intervals.length; cursor++) {
    const [left, right] = intervals[cursor];
    const middle = Math.floor((left + right) / 2);
    spreadRank[middle] = cursor;
    if (left < middle) intervals.push([left, middle - 1]);
    if (middle < right) intervals.push([middle + 1, right]);
  }
  const ranked = matches.map(({ chunk, hits }) => ({
    ...chunk,
    score: hits.reduce((score, hit, position) => score + (hit ? Math.min(terms[position].length, 12) * Math.log(1 + index.chunks.length / frequency[position]) : 0), 0),
  })).sort((a, b) => b.score - a.score || spreadRank[a.index] - spreadRank[b.index]);
  // Keep introductory context, then matched evidence from anywhere in the
  // document. Reserve a small structural sample for non-lexical/global questions.
  add({ start: 0, end: boundary(index.text, Math.min(600, index.totalChars)) });
  for (const chunk of ranked.filter(chunk => chunk.score > 0)) {
    if (budgetChars - size(ranges) <= Math.min(2400, Math.floor(budgetChars / 8))) break;
    add({ start: boundary(index.text, chunk.start - overlap), end: boundary(index.text, chunk.end + overlap, true) });
  }
  for (const fraction of [1, 0.25, 0.5, 0.75]) {
    const chunk = index.chunks[Math.min(index.chunks.length - 1, Math.floor(index.chunks.length * fraction))];
    add(chunk);
  }
  for (const chunk of ranked) add(chunk);
  const selectedChars = size(ranges);
  return {
    sources: ranges.flatMap(range => partition(index.text, range.start, range.end).map(part => source(index, part, `${prefix}R${part.start}`))),
    outline: index.outline,
    coverage: { strategy: 'relevant', totalChars: index.totalChars, selectedChars, complete: selectedChars === index.totalChars, ranges, missingAnnotations, ambiguousAnnotations },
  };
}

export function documentBatches(index, { batchChars = 12000, prefix = 'P' } = {}) {
  positiveSize(batchChars, CHUNK_CHARS);
  safePrefix(prefix);
  const batches = [];
  let current = null;
  for (const chunk of index.chunks) {
    if (!current || chunk.end - current.start > batchChars) {
      current = { index: batches.length, sources: [], start: chunk.start, end: chunk.start };
      batches.push(current);
    }
    current.sources.push(source(index, chunk, `${prefix}${chunk.index + 1}`));
    current.end = chunk.end;
  }
  return batches;
}
