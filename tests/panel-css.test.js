import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("streaming assistant text preserves source line breaks until rich rendering", async () => {
  const css = await readFile(new URL("../src/panel/panel.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<!doctype html><style>${css}</style>
    <div class="message-bubble typing-caret">
      <div class="message-content">line one\nline two</div>
    </div>`);

  const content = dom.window.document.querySelector(".message-content");
  assert.equal(dom.window.getComputedStyle(content).whiteSpace, "pre-wrap");
});
