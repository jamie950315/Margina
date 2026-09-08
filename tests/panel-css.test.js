import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("sidebar supports system appearance and readable reduced-transparency surfaces", async () => {
  const css = await readFile(new URL("../src/panel/panel.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../src/panel/panel.html", import.meta.url), "utf8");
  assert.match(html, /name="color-scheme" content="light dark"/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /-webkit-backdrop-filter:/);
  assert.doesNotMatch(html, /class="ambient|PAGE COMPANION|RECENT CHATS|CONNECTION/);
});

test("streaming assistant text preserves source line breaks until rich rendering", async () => {
  const css = await readFile(new URL("../src/panel/panel.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<!doctype html><style>${css}</style>
    <div class="message-bubble typing-caret">
      <div class="message-content">line one\nline two</div>
    </div>`);

  const content = dom.window.document.querySelector(".message-content");
  assert.equal(dom.window.getComputedStyle(content).whiteSpace, "pre-wrap");
});

test("dismissed error notices hide their close control from keyboard navigation", async () => {
  const css = await readFile(new URL("../src/panel/panel.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<!doctype html><style>${css}</style>
    <div class="toast"><button>關閉</button></div>`);
  const toast = dom.window.document.querySelector(".toast");
  assert.equal(dom.window.getComputedStyle(toast).visibility, "hidden");
  toast.classList.add("is-visible");
  assert.equal(dom.window.getComputedStyle(toast).visibility, "visible");
  assert.equal(dom.window.getComputedStyle(toast).pointerEvents, "auto");
});

test("modal visibility does not depend on a running animation clock", async () => {
  const css = await readFile(new URL("../src/panel/panel.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<!doctype html><style>${css}</style>
    <section class="settings-sheet is-open"></section><aside class="history-drawer is-open"></aside>`);
  for (const element of dom.window.document.querySelectorAll("section, aside")) {
    const style = dom.window.getComputedStyle(element);
    assert.equal(style.visibility, "visible");
    assert.ok(!style.transition || style.transition === "none");
  }
});
