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

test("centered reader prefers the actual live selection when duplicate text exists", t => {
  const repeated = "same selected words";
  const { reader, dom } = fixture(t, `${repeated} ${"middle ".repeat(30_000)} ${repeated} tail`);
  const node = dom.window.document.querySelector("p").firstChild;
  const second = node.data.lastIndexOf(repeated);
  const range = dom.window.document.createRange();
  range.setStart(node, second);
  range.setEnd(node, second + repeated.length);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const plan = reader.prepare({ strategy: "centered", budgetTokens: 300, anchorSelection: repeated });
  assert.equal(plan.context.coverage.strategy, "centered");
  assert.ok(plan.context.coverage.anchorOffset > plan.totalChars * 0.9);
  assert.match(plan.context.sources.map(source => source.quote).join(""), /same selected words tail/);
});

test("centered reader falls back to viewport geometry and keeps a bounded contiguous range", t => {
  const dom = new JSDOM("<title>Viewport</title><main><p>TOP_MARKER " + "top ".repeat(5000) + "</p><p>" + "center ".repeat(2500) + " VIEWPORT_MARKER " + "center ".repeat(2500) + "</p><p>BOTTOM_MARKER " + "bottom ".repeat(5000) + "</p></main>", { url: "https://example.com/viewport" });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 800 });
  dom.window.document.documentElement.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 800, width: 600, height: 800 });
  dom.window.document.caretRangeFromPoint = (x, y) => {
    assert.equal(x, 300, "viewport center excludes the reserved sidebar width");
    assert.equal(y, 400);
    return null;
  };
  dom.window.Range.prototype.getClientRects = function getClientRects() {
    const value = this.startContainer?.data ?? "";
    const top = value.includes("VIEWPORT_MARKER") ? 350 : value.includes("TOP_MARKER") ? -5000 : 5000;
    return [{ left: 100, right: 900, top, bottom: top + 100, width: 800, height: 100 }];
  };
  const plan = createLongReader(dom.window.document).prepare({ strategy: "centered", budgetTokens: 300, annotations: ["TOP_MARKER"] });
  const joined = plan.context.sources.map(source => source.quote).join("");
  assert.match(joined, /VIEWPORT_MARKER/);
  assert.doesNotMatch(joined, /TOP_MARKER|BOTTOM_MARKER/);
  assert.equal(plan.context.coverage.ranges.length, 1);
});

test("centered reader returns every source when the full text fits", t => {
  const { reader } = fixture(t, "short complete body");
  const plan = reader.prepare({ strategy: "centered", budgetTokens: 100 });
  assert.equal(plan.context.coverage.complete, true);
  assert.match(plan.context.sources.map(source => source.quote).join(""), /Heading short complete body/);
});
