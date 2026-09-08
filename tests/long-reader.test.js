import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createLongReader } from "../src/content/long-reader.js";

function fixture(t, text) {
  const dom = new JSDOM("<title>Long article</title><main><h1>Heading</h1><p></p></main>", { url: "https://example.com/a?private=1#part" });
  dom.window.document.querySelector("p").textContent = text;
  t.after(() => dom.window.close());
  return { dom, reader: createLongReader(dom.window.document) };
}

test("long reader indexes million-character body but transports only bounded excerpts and batches", t => {
  const { reader } = fixture(t, "背景內容。".repeat(200_000) + "結尾答案是北極星。");
  const plan = reader.prepare({ query: "北極星", budgetChars: 16_000 });
  assert.ok(plan.totalChars > 1_000_000);
  assert.equal(plan.text, undefined);
  assert.ok(plan.context.sources.reduce((n, source) => n + source.quote.length, 0) <= 16_000);
  assert.ok(plan.context.sources.some(source => source.quote.includes("北極星")));
  assert.match(plan.context.outline, /Heading/);
  const first = reader.readBatch({ snapshotId: plan.snapshotId, index: 0 });
  assert.equal(first.start, 0);
  assert.ok(first.sources.reduce((n, source) => n + source.quote.length, 0) <= 12_000);
  const last = reader.readBatch({ snapshotId: plan.snapshotId, index: plan.batchCount - 1 });
  assert.equal(last.end, plan.totalChars);
  assert.match(last.sources.at(-1).quote, /北極星/);
});

test("long reader invalidates navigation, changed body, replacement snapshots and release", t => {
  const { reader, dom } = fixture(t, "original article");
  let plan = reader.prepare();
  assert.deepEqual(reader.validate(plan), { ok: true });
  const previous = plan;
  plan = reader.prepare();
  assert.throws(() => reader.validate(previous), /變更/);
  assert.deepEqual(reader.validate(plan), { ok: true }, "an old caller must not destroy a newer snapshot");
  plan = reader.prepare();
  dom.window.history.pushState({}, "", "?private=2");
  assert.throws(() => reader.readBatch({ ...plan, index: 0 }), /變更/);
  plan = reader.prepare();
  dom.window.document.querySelector("p").textContent += " changed";
  assert.throws(() => reader.validate(plan), /變更/);
  plan = reader.prepare();
  reader.release(plan);
  assert.throws(() => reader.validate(plan), /變更/);
});

test("long reader ignores style, hidden and extension tool mutations and rejects oversize/invalid batches", t => {
  const { reader, dom } = fixture(t, "safe body");
  const plan = reader.prepare();
  const style = dom.window.document.createElement("style");
  style.textContent = "p { color: red; }";
  dom.window.document.querySelector("main").append(style);
  const tools = dom.window.document.createElement("div");
  tools.dataset.safaiReadingTools = "";
  tools.textContent = "private extension controls";
  dom.window.document.querySelector("main").append(tools);
  assert.deepEqual(reader.validate(plan), { ok: true });
  for (const index of [-1, 0.5, plan.batchCount]) assert.throws(() => reader.readBatch({ ...plan, index }), /編號/);
  dom.window.document.querySelector("p").textContent = "字".repeat(2_000_001);
  assert.throws(() => reader.prepare(), /兩百萬/);
});

test("outline and body exclude hidden headings, hidden children and editable drafts", t => {
  const { reader, dom } = fixture(t, "visible text");
  dom.window.document.querySelector("main").insertAdjacentHTML("beforeend", '<div style="display:none"><h2>HIDDEN_SECRET</h2></div><h2>Visible title<span hidden>CHILD_SECRET</span></h2><div contenteditable="true">DRAFT_SECRET</div>');
  const plan = reader.prepare();
  assert.match(plan.context.outline, /Visible title/);
  assert.doesNotMatch(JSON.stringify(plan), /SECRET/);
});
