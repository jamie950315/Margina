import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { PAGE_LAYOUT_ATTRIBUTE, PAGE_PANEL_WIDTH_PROPERTY } from "../src/core/panel-layout.js";

const source = buildSync({
  entryPoints: ["src/content/index.js"],
  bundle: true,
  write: false,
  format: "iife",
}).outputFiles[0].text;

async function contentHarness(t) {
  const dom = new JSDOM("<!doctype html><body><main>Article</main></body>", {
    url: "https://example.com/article",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.document.elementFromPoint = () => window.document.body;
  let toggle;
  let port;
  let finishCapture;
  let captureStarted;
  const started = new Promise((resolve) => { captureStarted = resolve; });
  window.browser = {
    runtime: {
      getURL: (path) => `https://extension.example/${path}`,
      onMessage: { addListener: (listener) => { toggle = listener; } },
      sendMessage: () => {
        captureStarted();
        return new Promise((resolve) => { finishCapture = resolve; });
      },
    },
  };
  const replies = new Map();
  window.MessageChannel = class {
    constructor() {
      this.port1 = port = {
        start() {},
        close() {},
        postMessage(message) { replies.get(message.requestId)?.(message); },
      };
      this.port2 = {};
    }
  };
  let shadow;
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    shadow = attachShadow.call(this, options);
    return shadow;
  };
  window.eval(source);
  await toggle({ type: "TOGGLE_SAFAI_PANEL" });
  shadow.querySelector("iframe").dispatchEvent(new window.Event("load"));
  let requestId = 0;
  return {
    window,
    host: window.document.getElementById("safai-extension-panel-host"),
    shadow,
    started,
    finishCapture: () => finishCapture({ ok: true, dataUrl: "data:image/png;base64,aA==" }),
    request(type) {
      const id = ++requestId;
      const response = new Promise((resolve) => replies.set(id, resolve));
      port.onmessage({ data: { type, requestId: id } });
      return response;
    },
  };
}

test("the sidebar floats inside its reserved space with protected host-side glass", async (t) => {
  const { host, shadow, window } = await contentHarness(t);
  assert.equal(host.shadowRoot, null, "the webpage cannot access the private iframe or material");
  assert.equal(host.style.inset, "10px 10px 10px auto");
  assert.equal(host.style.width, "322px");
  assert.equal(host.style.height, "calc(100vh - 20px)");
  assert.equal(window.document.documentElement.style.getPropertyValue(PAGE_PANEL_WIDTH_PROPERTY), "342px");
  const frame = shadow.querySelector("iframe");
  assert.equal(frame.style.background, "transparent");
  assert.equal(frame.style.borderRadius, "22px");
  assert.ok(shadow.querySelector(".panel-material"));
  const styles = [...shadow.querySelectorAll("style")].map((style) => style.textContent).join("\n");
  assert.match(styles, /-webkit-backdrop-filter:\s*blur\(36px\) saturate\(1\.45\)/);
  assert.match(styles, /prefers-color-scheme:\s*dark/);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/);
  assert.match(styles, /backdrop-filter:\s*none/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});

test("resizing floating glass retains its gutters and reports the visible width", async (t) => {
  const { host, shadow, window } = await contentHarness(t);
  const handle = shadow.querySelector('[role="separator"]');
  assert.equal(handle.getAttribute("aria-valuenow"), "322");
  handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft" }));
  assert.equal(host.style.width, "338px");
  assert.equal(handle.getAttribute("aria-valuenow"), "338");
  assert.equal(window.document.documentElement.style.getPropertyValue(PAGE_PANEL_WIDTH_PROPERTY), "358px");
  window.innerWidth = 375;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(host.style.width, "300px");
  assert.equal(handle.getAttribute("aria-valuenow"), "300");
  assert.equal(handle.getAttribute("aria-valuemin"), "300");
  assert.equal(handle.getAttribute("aria-valuemax"), "300");
});

test("closing the panel during capture does not reopen it or restore its page inset", async (t) => {
  const harness = await contentHarness(t);
  const capture = harness.request("CAPTURE_VIEWPORT");
  await harness.started;
  await harness.request("CLOSE_PANEL");
  harness.finishCapture();
  assert.equal((await capture).ok, true);
  assert.equal(harness.host.style.display, "none");
  assert.equal(harness.window.document.documentElement.hasAttribute(PAGE_LAYOUT_ATTRIBUTE), false);
});

test("viewport capture rejects a result after the page scrolls", async (t) => {
  const harness = await contentHarness(t);
  const capture = harness.request("CAPTURE_VIEWPORT");
  await harness.started;
  harness.window.scrollY = 150;
  harness.finishCapture();
  const response = await capture;
  assert.equal(response.ok, false);
  assert.match(response.error, /移動/);
});

for (const blocked of ["paint", "capture"]) {
  test(`a stalled ${blocked} reports an error and restores the sidebar`, async (t) => {
    const harness = await contentHarness(t);
    const originalTimer = harness.window.setTimeout.bind(harness.window);
    harness.window.setTimeout = (callback, delay) => originalTimer(callback, delay >= 2000 ? 50 : delay);
    if (blocked === "paint") harness.window.requestAnimationFrame = () => 1;
    const response = await Promise.race([
      harness.request("CAPTURE_VIEWPORT"),
      new Promise((resolve) => setTimeout(() => resolve({ error: "test deadline" }), 250)),
    ]);
    assert.equal(response.ok, false);
    assert.match(response.error, /逾時|未更新/);
    assert.equal(harness.host.style.display, "block");
  });
}

test("finishing a cancelled image crop does not disrupt the next element picker", async (t) => {
  const harness = await contentHarness(t);
  let imageReady;
  const imageCreated = new Promise((resolve) => { imageReady = resolve; });
  harness.window.Image = class {
    naturalWidth = 1024;
    naturalHeight = 768;
    constructor() { imageReady(this); }
  };
  harness.window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  harness.window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,aA==";
  harness.window.document.body.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100,
  });
  const firstPicker = harness.request("PICK_ELEMENT");
  const confirmation = harness.request("PICKER_CONFIRM");
  await harness.started;
  harness.finishCapture();
  const pendingImage = await imageCreated;
  await harness.request("CANCEL_PICKER");
  assert.equal((await firstPicker).cancelled, true);

  let nextResult;
  harness.request("PICK_ELEMENT").then((result) => { nextResult = result; });
  pendingImage.onload();
  await confirmation;
  await harness.request("CANCEL_PICKER");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextResult?.cancelled, true);
});
