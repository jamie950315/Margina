import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sourcesForPage } from "../src/core/citations.js";
import { clearReadingHighlights, createReadingTools, locateQuote } from "../src/content/reading-tools.js";
import { readPageContext } from "../src/content/page-reader.js";

test("sources are bounded exact excerpts with safe metadata and complete coverage", () => {
  const page = { text: "Same paragraph.\n\nSame paragraph.\n\n" + "Long text ".repeat(6000), url: "https://u:p@example.com/a?q=secret#hash", title: "Title" };
  const sources = sourcesForPage(page);
  assert.ok(sources.length <= 32);
  assert.equal(sources[0].id, "P1");
  assert.equal(sources[0].url, "https://example.com/a");
  assert.equal(sources.map(s => s.quote).join(""), page.text.slice(0, 32_000));
  assert.ok(sources.every(s => s.quote.length <= 1200 && page.text.includes(s.quote)));
  assert.deepEqual(sourcesForPage(page, { maxSources: 0 }), []);
  assert.deepEqual(sourcesForPage({ text: "text", url: "javascript:alert(1)" }), []);
  const shortParagraphs = { ...page, text: "短段落。\n\n".repeat(4000).slice(0, 16000) };
  assert.equal(sourcesForPage(shortParagraphs, { maxSources: 14 }).map(s => s.quote).join(""), shortParagraphs.text);
  const unicodePage = { ...page, text: "a".repeat(1199) + "🌙" + "more" };
  assert.equal(sourcesForPage(unicodePage).map(s => s.quote).join(""), unicodePage.text);
  assert.equal(sourcesForPage(unicodePage)[0].quote.length, 1199);
});

test("quote locator matches across inline nodes and refuses stale or ambiguous text", () => {
  const dom = new JSDOM("<main><p>The <b>bright</b>   moon.</p><p>Other text.</p><script>Invisible quote</script></main>", { url: "https://example.com/a?x=1" });
  const doc = dom.window.document;
  let scrolled = false;
  dom.window.Element.prototype.scrollIntoView = () => { scrolled = true; };
  assert.deepEqual(locateQuote({ quote: "The bright moon.", url: "https://example.com/a" }, doc), { ok: true });
  assert.ok(scrolled);
  assert.ok(doc.querySelector("[data-safai-reading-highlight]"));
  clearReadingHighlights(doc);
  assert.equal(doc.querySelector("[data-safai-reading-highlight]"), null);
  assert.equal(doc.querySelector("p").innerHTML, "The <b>bright</b>   moon.");
  assert.throws(() => locateQuote({ quote: "Other text.", url: "https://example.com/b" }, doc), /頁面/);
  assert.throws(() => locateQuote({ quote: "Invisible quote", url: "https://example.com/a" }, doc), /找不到/);
  doc.body.insertAdjacentHTML("beforeend", "<p>Other text.</p>");
  assert.throws(() => locateQuote({ quote: "Other text.", url: "https://example.com/a" }, doc), /多處/);
  dom.window.close();
});

test("selection toolbar stays closed-shadow, drafts only and disables cleanly", () => {
  const dom = new JSDOM("<p>Hello selected words.</p><input type=password><div contenteditable=true>Editable text</div>", { url: "https://example.com" });
  const { window } = dom;
  const { document } = window;
  let shadow;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (args) { shadow = attach.call(this, args); return shadow; };
  window.Range.prototype.getBoundingClientRect = () => ({ left: 20, right: 90, top: 40, bottom: 60, width: 70, height: 20 });
  const asks = [];
  const tools = createReadingTools({ document, window, onAsk: value => asks.push(value) });
  const host = document.documentElement.lastElementChild;
  const select = (element) => { const range = document.createRange(); range.selectNodeContents(element); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); document.dispatchEvent(new window.Event("mouseup")); };
  select(document.querySelector("p"));
  assert.equal(host.shadowRoot, null);
  assert.equal(host.style.display, "block");
  assert.equal(host.style.getPropertyPriority("display"), "important");
  shadow.querySelector("button").click();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].selection, "Hello selected words.");
  assert.equal(host.style.display, "none");
  select(document.querySelector("[contenteditable]"));
  assert.equal(host.style.display, "none");
  document.querySelector("input").focus();
  select(document.querySelector("p"));
  assert.equal(host.style.display, "none");
  document.querySelector("input").blur();
  tools.setEnabled(false);
  select(document.querySelector("p"));
  assert.equal(host.style.display, "none");
  tools.setEnabled(true);
  tools.suspend();
  select(document.querySelector("p"));
  assert.equal(host.style.display, "none");
  tools.resume();
  select(document.querySelector("p"));
  document.dispatchEvent(new window.Event("scroll"));
  assert.equal(host.style.display, "none");
  select(document.querySelector("p"));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(host.style.display, "none");
  tools.destroy();
  assert.equal(host.isConnected, false);
  dom.window.close();
});

test("quote locator ignores hidden text and can cross visible blocks", () => {
  const dom = new JSDOM("<p>First <em>visible</em> block.</p><p>Second block.</p><div style='display:none'>Secret hidden words</div>", { url: "https://example.com/" });
  assert.deepEqual(locateQuote({ quote: "First visible block. Second block.", url: "https://example.com/" }, dom.window.document), { ok: true });
  assert.throws(() => locateQuote({ quote: "Secret hidden words", url: "https://example.com/" }, dom.window.document), /找不到/);
  dom.window.close();
});

test("sources from compacted rendered page text locate paragraphs and CSS line breaks", () => {
  const dom = new JSDOM("<main><h1>Reading heading</h1><p>First <em>visible</em> paragraph.</p><p>Second line<br>Third line</p><span style='display:block'>Fourth line</span><span style='display:block'>Last line.</span></main>", { url: "https://example.com/" });
  // jsdom does not implement rendered innerText; mirror the browser's visible line breaks.
  Object.defineProperty(dom.window.document.querySelector("main"), "innerText", { value: "Reading heading\n\nFirst visible paragraph.\n\nSecond line\nThird line\nFourth line\nLast line." });
  const page = readPageContext(dom.window.document);
  assert.equal(page.text.includes("\n"), false);
  const sources = sourcesForPage(page);
  assert.ok(sources.length);
  for (const source of sources) assert.deepEqual(locateQuote(source, dom.window.document), { ok: true });
  dom.window.close();
});

test("keyboard selection can Tab directly into the closed toolbar and Escape out", () => {
  const dom = new JSDOM("<button id=previous>Previous focus</button><p>Keyboard selection</p><a href='/'>Other page link</a>", { url: "https://example.com/" });
  const { window } = dom;
  const { document } = window;
  let shadow;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (args) { shadow = attach.call(this, args); return shadow; };
  window.Range.prototype.getBoundingClientRect = () => ({ left: 20, top: 40, bottom: 60, width: 90, height: 20 });
  const tools = createReadingTools({ document, window, onAsk() {} });
  document.querySelector("button").focus();
  const range = document.createRange(); range.selectNodeContents(document.querySelector("p")); window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  document.dispatchEvent(new window.KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
  assert.equal(shadow.activeElement, shadow.querySelector("button"));
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.activeElement.id, "previous");
  tools.destroy(); dom.window.close();
});
