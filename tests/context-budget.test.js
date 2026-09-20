import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentIndex } from "../src/core/long-document.js";
import { estimateTokens, selectCenteredContext } from "../src/core/context-budget.js";

test("token estimation is deterministic, multilingual, and rejects non-strings", () => {
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(estimateTokens("hello, world!"), 6);
  assert.equal(estimateTokens("中文"), 4);
  assert.equal(estimateTokens("😀"), 4);
  assert.throws(() => estimateTokens({ text: "not serialized" }), /string/);
});

test("centered context preserves the entire document when it fits", () => {
  const text = "Complete multilingual 正文 😀";
  const result = selectCenteredContext({ text, title: "Page", url: "https://example.org/" }, { budgetTokens: estimateTokens(text) });
  assert.equal(result.sources.map(source => source.quote).join(""), text);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.ranges, [{ start: 0, end: text.length }]);
  assert.equal(result.coverage.estimatedTokens, estimateTokens(text));
});

test("truncated context is one contiguous window centered on an explicit selection", () => {
  const marker = "UNIQUE CURRENT SELECTION";
  const text = "before ".repeat(20_000) + marker + " after".repeat(20_000);
  const result = selectCenteredContext(createDocumentIndex({ text }), {
    budgetTokens: 600,
    anchorSelection: marker,
    annotations: ["a retained annotation that is not on this page"],
    prefix: "C1",
  });
  const joined = result.sources.map(source => source.quote).join("");
  assert.match(joined, /UNIQUE CURRENT SELECTION/);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.ranges.length, 1);
  assert.ok(result.coverage.estimatedTokens <= 600);
  assert.equal(result.coverage.missingAnnotations, 1);
  assert.equal(joined, text.slice(result.coverage.ranges[0].start, result.coverage.ranges[0].end));
  assert.ok(result.sources.every(source => source.quote.length <= 1200));
});

test("explicit offset can center a tail window without requiring annotations", () => {
  const text = "head ".repeat(50_000) + "TAIL FACT" + " end".repeat(200);
  const anchorOffset = text.indexOf("TAIL FACT") + 4;
  const result = selectCenteredContext({ text }, { budgetTokens: 200, anchorOffset });
  assert.match(result.sources.map(source => source.quote).join(""), /TAIL FACT/);
  assert.equal(result.coverage.anchorOffset, anchorOffset);
  assert.ok(result.coverage.ranges[0].start > text.length * 0.9);
});

test("zero and invalid budgets remain explicit and never split surrogate pairs", () => {
  const index = createDocumentIndex({ text: "a😀b".repeat(100) });
  const empty = selectCenteredContext(index, { budgetTokens: 0, anchorOffset: 2 });
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.coverage.selectedChars, 0);
  const selected = selectCenteredContext(index, { budgetTokens: 20, anchorOffset: 2 });
  for (const source of selected.sources) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(source.quote));
  assert.throws(() => selectCenteredContext(index, { budgetTokens: -1 }), /token/);
  assert.throws(() => selectCenteredContext(index, { budgetTokens: 1.5 }), /token/);
});

test("source chunks stay within the locator limit when an emoji crosses the boundary", () => {
  const text = "a".repeat(1199) + "😀" + "b".repeat(1200);
  const result = selectCenteredContext({ text }, { budgetTokens: estimateTokens(text) });
  assert.equal(result.sources.map(source => source.quote).join(""), text);
  assert.ok(result.sources.every(source => source.quote.length <= 1200));
  assert.ok(result.sources.every(source => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(source.quote)));
});
