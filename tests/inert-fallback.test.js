import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { createInertController } from "../src/panel/inert-controller.js";

test("createInertController disables and restores controls when native inert is unavailable", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="region" aria-hidden="false">
      <button id="enabled">Enabled</button>
      <button id="disabled" disabled>Disabled</button>
      <a id="link" href="https://example.com">Link</a>
    </section>
  </body>`);
  const region = dom.window.document.getElementById("region");
  const enabled = dom.window.document.getElementById("enabled");
  const disabled = dom.window.document.getElementById("disabled");
  const link = dom.window.document.getElementById("link");
  const setInert = createInertController(dom.window);

  setInert(region, true);

  assert.equal(region.classList.contains("safai-inert-fallback"), true);
  assert.equal(region.getAttribute("aria-hidden"), "true");
  assert.equal(enabled.disabled, true);
  assert.equal(disabled.disabled, true);
  assert.equal(link.getAttribute("tabindex"), "-1");

  const added = dom.window.document.createElement("button");
  region.append(added);
  setInert(region, true);
  assert.equal(added.disabled, true);

  setInert(region, false);

  assert.equal(region.classList.contains("safai-inert-fallback"), false);
  assert.equal(region.getAttribute("aria-hidden"), "false");
  assert.equal(enabled.disabled, false);
  assert.equal(disabled.disabled, true);
  assert.equal(added.disabled, false);
  assert.equal(link.hasAttribute("tabindex"), false);
});

test("createInertController delegates to native inert when the browser supports it", () => {
  const dom = new JSDOM("<!doctype html><body><section><button>Action</button></section></body>");
  const values = new WeakMap();
  Object.defineProperty(dom.window.HTMLElement.prototype, "inert", {
    configurable: true,
    get() {
      return values.get(this) ?? false;
    },
    set(value) {
      values.set(this, Boolean(value));
    },
  });
  const region = dom.window.document.querySelector("section");
  const button = region.querySelector("button");
  const setInert = createInertController(dom.window);

  setInert(region, true);

  assert.equal(region.inert, true);
  assert.equal(button.disabled, false);
  assert.equal(region.classList.contains("safai-inert-fallback"), false);
});
