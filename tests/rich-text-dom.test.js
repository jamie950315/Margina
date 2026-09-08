import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { renderMessageMarkdown } from "../src/core/message-renderer.js";
import { createMessageSanitizer } from "../src/panel/rich-text-dom.js";

function sanitizedContainer(html) {
  const dom = new JSDOM("<!doctype html><body></body>");
  const sanitize = createMessageSanitizer(dom.window);
  const container = dom.window.document.createElement("div");
  container.append(sanitize(html));
  return container;
}

test("createMessageSanitizer removes executable, interactive, and clobbering markup", () => {
  const container = sanitizedContainer(`<div id="owned" name="owned" data-state="bad">
    <script>alert(1)</script>
    <style>body { display: none }</style>
    <img src="https://tracker.example/pixel" onerror="alert(2)">
    <svg onload="alert(3)"><path d="M0 0"></path></svg>
    <svg><image href="https://tracker.example/pixel"></image></svg>
    <form action="https://evil.example"><input name="secret"></form>
    <a href="javascript:alert(4)">unsafe</a>
    <a href="https://example.com/docs">safe</a>
  </div>`);

  assert.equal(
    container.querySelector("script, style, img, image, form, input, iframe, object, embed"),
    null,
  );
  assert.equal(container.querySelector("[onload], [onerror], [id], [name], [data-state]"), null);
  assert.equal(container.querySelector('a[href^="javascript:"]'), null);
  const safe = container.querySelector('a[href="https://example.com/docs"]');
  assert.ok(safe);
  assert.equal(safe.target, "_blank");
  assert.equal(safe.rel, "noopener noreferrer");
});

test("createMessageSanitizer preserves KaTeX HTML, SVG, MathML, and layout styles", () => {
  const rendered = renderMessageMarkdown(String.raw`\[\sqrt{\frac{a}{b}}\]`);
  const container = sanitizedContainer(rendered);

  assert.ok(container.querySelector(".katex"));
  assert.ok(container.querySelector("math"));
  assert.ok(container.querySelector("svg"));
  assert.ok(container.querySelector("[style]"));
});
