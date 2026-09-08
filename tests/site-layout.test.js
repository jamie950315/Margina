import test from "node:test";
import assert from "node:assert/strict";
import { siteLayoutCSS } from "../src/content/site-layout.js";

test("X layout adaptation is limited to exact hosts and an open sidebar", () => {
  assert.equal(siteLayoutCSS("example.com", 1100), "");
  assert.equal(siteLayoutCSS("x.com.example.com", 1100), "");
  const css = siteLayoutCSS("x.com", 1100);
  assert.match(css, /html\[data-safai-extension-panel-open\] main/);
  assert.match(css, /flex-shrink: 0/);
  assert.doesNotMatch(css, /display: none/);
  assert.match(siteLayoutCSS("x.com", 800), /display: none/);
});
