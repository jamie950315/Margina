import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createFixedPageLayout } from "../src/content/page-reflow.js";

test("fixed page controls fit the remaining width and restore authored styles", () => {
  const dom = new JSDOM('<body><header style="position:fixed;right:0;width:100vw;color:red"></header></body>');
  const { document } = dom.window;
  const header = document.querySelector("header");
  header.getBoundingClientRect = () => ({ left: 0, right: 1200, width: 1200 });
  const layout = createFixedPageLayout(document, () => 1200);
  layout.apply(342);
  assert.equal(header.style.right, "342px");
  assert.equal(header.style.maxWidth, "858px");
  layout.apply(400);
  assert.equal(header.style.right, "400px");
  layout.clear();
  assert.equal(header.style.right, "0px");
  assert.equal(header.style.maxWidth, "");
  assert.equal(header.style.color, "red");
  dom.window.close();
});

test("does not change in-flow elements, extension UI, or fixed descendants of transformed elements", () => {
  const dom = new JSDOM('<body><main></main><div style="transform:translateX(0)"><button style="position:fixed">x</button></div></body>');
  const layout = createFixedPageLayout(dom.window.document, () => 1200);
  const before = dom.window.document.body.innerHTML;
  layout.apply(342);
  layout.clear();
  assert.equal(dom.window.document.body.innerHTML, before);
  dom.window.close();
});

test("closing preserves a site's newer inline change", () => {
  const dom = new JSDOM('<body><header style="position:fixed;right:0"></header></body>');
  const header = dom.window.document.querySelector('header');
  header.getBoundingClientRect = () => ({ left: 1100, right: 1200, width: 100 });
  const layout = createFixedPageLayout(dom.window.document, () => 1200);
  layout.apply(342);
  header.style.right = '20px';
  layout.clear();
  assert.equal(header.style.right, '20px');
  dom.window.close();
});

test("centered translated controls move by a delta, not a visual coordinate", () => {
  const dom = new JSDOM('<body><div style="position:fixed;left:600px;transform:translateX(-50%);width:600px"></div></body>');
  const element = dom.window.document.querySelector('div');
  element.getBoundingClientRect = () => ({ left: 300, right: 900, width: 600 });
  const layout = createFixedPageLayout(dom.window.document, () => 1200);
  layout.apply(342);
  assert.equal(element.style.left, '558px');
  layout.clear();
  assert.equal(element.style.left, '600px');
  dom.window.close();
});
