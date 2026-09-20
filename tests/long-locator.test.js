import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { locateQuote, clearReadingHighlights } from "../src/content/reading-tools.js";
import { createLongReader } from "../src/content/long-reader.js";

test("long-reader citations locate across semantic inline blocks and empty separators", t => {
  const { doc, range } = fixture(t, "<main><h1>Webb</h1><div style='display:inline'>Mirror</div><span>diameter</span><hr><span>comparison.</span><p>Launch <b>date</b></p></main>");
  const prepared = createLongReader(doc).prepare({ strategy: "centered", budgetTokens: 8192 });
  const quote = prepared.context.sources[0].quote;
  assert.match(quote, /diameter comparison/);
  assert.equal(locateQuote({ quote, url: "https://example.com/long" }, doc).ok, true);
  assert.equal(range().startContainer.data, "Webb");
});

function fixture(t, html = "<main><p></p><p id='tail'></p></main>") {
  const dom = new JSDOM(html, { url: "https://example.com/long?private=1" });
  t.after(() => dom.window.close());
  let range;
  const createRange = dom.window.document.createRange.bind(dom.window.document);
  dom.window.document.createRange = () => { range = createRange(); return range; };
  return { doc: dom.window.document, range: () => range };
}

test("million-character tail citations map exact DOM endpoints without per-character records", t => {
  const { doc, range } = fixture(t);
  doc.querySelector("p").textContent = "背景文字。".repeat(200_000);
  doc.querySelector("#tail").innerHTML = "  尾端\n <b>北極星</b>\t  答案🌙。";
  const result = locateQuote({ quote: "尾端 北極星 答案🌙。", url: "https://example.com/long" }, doc);
  assert.deepEqual(result, { ok: true });
  assert.equal(range().toString(), "尾端\n 北極星\t  答案🌙。");
  assert.equal(range().startOffset, 2);
  assert.equal(range().endContainer, doc.querySelector("#tail").lastChild);
  assert.equal(doc.querySelector("[data-safai-reading-highlight]").shadowRoot, null);
  clearReadingHighlights(doc);
});

test("duplicate quote near million-character tail refuses ambiguous highlights", t => {
  const { doc } = fixture(t);
  doc.querySelector("p").textContent = "unique duplicate needle " + "背景。".repeat(320_000);
  doc.querySelector("#tail").textContent = "unique duplicate needle";
  assert.throws(() => locateQuote({ quote: "unique duplicate needle", url: "https://example.com/long" }, doc), /多處/);
  assert.equal(doc.querySelector("[data-safai-reading-highlight]"), null);
});

test("oversize documents fail explicitly instead of locating a prefix or claiming absent text", t => {
  const { doc } = fixture(t);
  doc.querySelector("p").textContent = "prefix needle " + "字".repeat(2_000_000);
  for (const quote of ["prefix needle", "absent needle"]) {
    assert.throws(() => locateQuote({ quote, url: "https://example.com/long" }, doc), /兩百萬/);
  }
});

test("locator rejects hidden and editable duplicate text while preserving whitespace mappings", t => {
  const { doc, range } = fixture(t, "<p>\tA<span> \n B</span><br>C<span style='display:block'>D</span></p><div hidden>A B C D</div><div contenteditable=true>A B C D</div><style>/* A B C D */</style>");
  assert.equal(locateQuote({ quote: "A B C D", url: "https://example.com/long" }, doc).ok, true);
  assert.equal(range().startOffset, 1);
  assert.equal(range().endContainer.data, "D");
  assert.equal(range().endOffset, 1);
});
