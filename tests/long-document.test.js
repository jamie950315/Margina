import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentIndex, selectDocumentContext, documentBatches, MAX_DOCUMENT_CHARS } from '../src/core/long-document.js';

test('source URL metadata keeps the existing 4096-character reader allowance', () => {
  const url = 'https://example.org/' + 'a'.repeat(3000);
  const index = createDocumentIndex({ text: 'Visible body', url });
  assert.equal(selectDocumentContext(index).sources[0].url, url);
});

test('broad questions sample across the document instead of filling mostly from the head', () => {
  const index = createDocumentIndex({ text: '一般背景內容。'.repeat(150000), url: 'https://example.org/' });
  const result = selectDocumentContext(index, { query: '總結全文' });
  const earlyChars = result.coverage.ranges.reduce((sum, range) => sum + Math.max(0, Math.min(range.end, index.totalChars / 10) - range.start), 0);
  assert.ok(earlyChars < 10000);
  assert.ok(result.coverage.ranges.some(range => range.start > index.totalChars * 0.9));
  assert.equal(result.coverage.complete, false);
});

test('a rare query term straddling a chunk boundary is retrieved with its complete word', () => {
  const index = createDocumentIndex({ text: 'x'.repeat(899995) + 'boundarytoken' + 'y'.repeat(100000), url: 'https://example.org/' });
  const result = selectDocumentContext(index, { query: 'boundarytoken' });
  assert.ok(result.sources.some(source => source.quote.includes('boundarytoken')));
});

test('million-character retrieval includes distant evidence and all annotation neighbors', () => {
  const text = '普通背景。'.repeat(150000) + '前文依據：預算增加。標註重點在這裡。後文補充：實際原因是冰川融化。' + '其他內容。'.repeat(50000);
  const index = createDocumentIndex({ text, url: 'https://example.org/', title: '研究' });
  const result = selectDocumentContext(index, { query: '冰川融化原因', annotations: ['標註重點在這裡。'] });
  const joined = result.sources.map(source => source.quote).join('');
  assert.ok(joined.includes('前文依據：預算增加。標註重點在這裡。後文補充：實際原因是冰川融化。'));
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.totalChars, text.length);
  assert.ok(result.coverage.selectedChars <= 32000);
  for (const source of result.sources) assert.equal(source.quote, text.slice(source.start, source.end));
});

test('Chinese relevance retrieves the tail without annotations', () => {
  const text = '一般資訊。'.repeat(20000) + '極地企鵝數量下降的原因是海冰消失。';
  const result = selectDocumentContext(createDocumentIndex({ text }), { query: '企鵝數量下降原因', budgetChars: 2400 });
  assert.ok(result.sources.some(source => source.quote.includes('海冰消失')));
});

test('ten distant annotations preserve 16000 characters plus their surrounding context', () => {
  const annotations = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(1599) + '終');
  const text = annotations.map(value => '外'.repeat(10000) + '前'.repeat(300) + value + '後'.repeat(300)).join('');
  const result = selectDocumentContext(createDocumentIndex({ text }), { annotations });
  for (const annotation of annotations) {
    const start = text.indexOf(annotation);
    assert.ok(result.coverage.ranges.some(range => range.start <= start - 300 && range.end >= start + annotation.length + 300));
  }
  assert.ok(result.coverage.selectedChars <= 32000);
  assert.throws(() => selectDocumentContext(createDocumentIndex({ text }), { annotations, budgetChars: 100 }), /標註/);
});

test('missing and ambiguous marks are disclosed rather than guessed', () => {
  const result = selectDocumentContext(createDocumentIndex({ text: '重複句子。其他。重複句子。' }), { annotations: ['不在頁面', '重複句子'] });
  assert.equal(result.coverage.missingAnnotations, 1);
  assert.equal(result.coverage.ambiguousAnnotations, 1);
});

test('small documents are complete and coverage has neither overlap nor hidden gaps', () => {
  const text = '正文完整保留。'.repeat(20);
  const result = selectDocumentContext(createDocumentIndex({ text }));
  assert.equal(result.sources.map(source => source.quote).join(''), text);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.ranges, [{ start: 0, end: text.length }]);
});

test('full-document batches cover every UTF-16 unit exactly once without broken emoji', () => {
  const text = '字😀'.repeat(18000);
  const index = createDocumentIndex({ text });
  const batches = documentBatches(index, { batchChars: 2500 });
  assert.equal(batches.flatMap(batch => batch.sources.map(source => source.quote)).join(''), text);
  const ids = batches.flatMap(batch => batch.sources.map(source => source.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const batch of batches) {
    assert.ok(batch.end - batch.start <= 2500);
    for (const source of batch.sources) {
      assert.ok(source.quote.length <= 1200);
      assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(source.quote));
    }
  }
  const result = selectDocumentContext(index, { budgetChars: 2401 });
  assert.ok(result.coverage.selectedChars <= 2401);
  for (const source of result.sources) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(source.quote));
});

test('rejects empty, oversize, incomplete reader snapshots and invalid options', () => {
  assert.throws(() => createDocumentIndex({ text: '' }), /正文/);
  assert.throws(() => createDocumentIndex({ text: 'a'.repeat(MAX_DOCUMENT_CHARS + 1) }), /上限/);
  assert.throws(() => createDocumentIndex({ text: '部分', truncated: true }), /完整/);
  const index = createDocumentIndex({ text: '資料' });
  assert.throws(() => selectDocumentContext(index, { budgetChars: NaN }));
  assert.throws(() => selectDocumentContext(index, { prefix: '<bad>' }));
  assert.throws(() => documentBatches(index, { batchChars: 1 }));
});
