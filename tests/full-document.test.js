import test from "node:test";
import assert from "node:assert/strict";
import { estimateFullReading, runFullReading } from "../src/core/full-document.js";

function fixture(count = 2, chars = 1200) {
  const plan = { snapshotId: "snapshot", title: "Article", url: "https://example.org/", totalChars: count * chars, batchCount: count, context: { sources: [] } };
  const batches = Array.from({ length: count }, (_, index) => ({ index, start: index * chars, end: (index + 1) * chars, sources: Array.from({length: Math.ceil(chars / 1200)}, (_, n) => {
    const start = index * chars + n * 1200, end = Math.min(start + 1200, (index + 1) * chars);
    return { id: `P${index * 10 + n + 1}`, quote: "x".repeat(end - start), start, end, title: plan.title, url: plan.url };
  }) }));
  return { plans: [plan], loadBatch: async (_, i) => batches[i], validatePlan: async () => true, query: "Find facts", batches };
}

test("estimates hierarchy and enforces budget before requests", () => {
  const data = fixture(84, 12000);
  assert.deepEqual(estimateFullReading(data.plans), { mapRequests: 84, reduceRequests: 18, answerRequests: 1, totalRequests: 103, inputChars: 1_008_000 + (84 + 14 + 3) * 1800, outputCharsEstimate: 102 * 1800 });
  assert.throws(() => estimateFullReading([...data.plans, ...data.plans, ...data.plans, ...data.plans]));
  assert.throws(() => estimateFullReading([{ ...data.plans[0], batchCount: 400 }]));
});

test("million-character reading covers every batch and retains tail fact through hierarchy", async () => {
  const data = fixture(84, 12000); const seen = []; const progress = [];
  const result = await runFullReading({ ...data, onProgress: p => progress.push(p), request: async (messages) => {
    const payload = JSON.parse(messages[1].content);
    if (payload.sources) { seen.push(payload.sources[0].start); return payload.sources[0].start === 996000 ? "tail fact [P831]" : "other fact"; }
    return payload.summaries.some(x => x.includes("tail fact")) ? "tail fact [P831]" : "other fact";
  } });
  assert.equal(seen.length, 84); assert.equal(result.pages[0].summary, "tail fact [P831]");
  assert.equal(result.pages[0].coverage.processedChars, 1_008_000);
  assert.equal(result.pages[0].coverage.complete, true);
  assert.equal(result.citationSources.length, 840);
  assert.equal(progress.at(-1).completed, 102);
});

test("cancellation and errors stop later requests", async () => {
  const data = fixture(); const controller = new AbortController(); let calls = 0;
  await assert.rejects(runFullReading({ ...data, signal: controller.signal, request: async () => { calls++; controller.abort(); return "summary"; } }), { name: "AbortError" });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(runFullReading({ ...data, request: async () => { calls++; throw new Error("provider failed"); } }), /provider failed/);
  assert.equal(calls, 1);
});

test("rejects malformed batches, invented citations, empty and oversized summaries", async () => {
  for (const response of ["", "x".repeat(1801), "invented [P999]"]) {
    await assert.rejects(runFullReading({ ...fixture(), request: async () => response }));
  }
  const data = fixture(); data.batches[0].sources[0].end--;
  let calls = 0;
  await assert.rejects(runFullReading({ ...data, request: async () => { calls++; return "summary"; } }));
  assert.equal(calls, 0);
});

test("stale final validation and identifiers from other batches fail closed", async () => {
  let validates = 0;
  await assert.rejects(runFullReading({ ...fixture(1), validatePlan: async () => ++validates < 2, request: async () => "summary" }));
  await assert.rejects(runFullReading({ ...fixture(2), request: async () => "wrong batch [P11]" }));
});

test("cancellation interrupts a stalled batch read without calling the provider", async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const reading = runFullReading({ ...fixture(), signal: controller.signal, loadBatch: async () => { started(); return new Promise(() => {}); }, request: async () => { assert.fail("provider must not run"); } });
  await ready;
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
});

test("rejects duplicate IDs, stale snapshot, missing tail and reduction-invented source", async () => {
  for (const mutate of [
    data => { data.batches[1].sources[0].id = data.batches[0].sources[0].id; },
    data => { data.batches[0].snapshotId = "changed"; },
    data => { data.plans[0].totalChars++; },
  ]) {
    const data = fixture(); mutate(data);
    await assert.rejects(runFullReading({ ...data, request: async () => "fact [P1]" }));
  }
  await assert.rejects(runFullReading({ ...fixture(), request: async messages => {
    const payload = JSON.parse(messages[1].content);
    return payload.sources ? "no cited details" : "invented [P1]";
  } }));
});
