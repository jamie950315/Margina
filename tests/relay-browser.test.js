import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../src/relay/browser.js", import.meta.url), "utf8");
const key = "a".repeat(64);

function harness(t) {
  const dom = new JSDOM(`<script src="http://127.0.0.1:43210/__safai/bridge.js?__safai_key=${key}"></script>`, { url: `http://127.0.0.1:43210/?__safai_key=${key}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const calls = [];
  dom.window.Request = Request;
  dom.window.Headers = Headers;
  dom.window.fetch = async (url, options = {}) => {
    if (options.body instanceof ReadableStream) throw new Error("ReadableStream uploading is not supported");
    calls.push({ url, options });
    return new Response("ok");
  };
  Object.defineProperty(dom.window.document, "currentScript", { get: () => dom.window.document.querySelector("script") });
  dom.window.eval(source);
  return { window: dom.window, calls };
}

test("relay fetch converts Request bodies into Safari-compatible buffered uploads", async t => {
  const { window, calls } = harness(t);
  const body = new Uint8Array([0, 255, 13, 10]);
  await window.fetch(new Request("https://chatgpt.com/backend-api/test", { method: "POST", body, headers: { "Content-Type": "application/octet-stream" } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:43210/backend-api/test");
  assert.deepEqual(new Uint8Array(calls[0].options.body), body);
  assert.equal(calls[0].options.headers.get("X-SafAI-Relay"), key);
  assert.equal(calls[0].options.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(window.location.search, "", "capability is removed from the visible document URL");
});

test("relay fetch honors caller overrides and never attaches capabilities to another host", async t => {
  const { window, calls } = harness(t);
  const controller = new AbortController();
  await window.fetch(new Request("https://chatgpt.com/backend-api/test", { method: "POST", body: "original" }), { body: "override", signal: controller.signal, headers: { "X-Test": "kept" } });
  assert.equal(calls[0].options.body, "override");
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.headers.get("X-Test"), "kept");
  await window.fetch("https://other.invalid/read", { headers: { "X-Test": "external" } });
  assert.equal(calls[1].url, "https://other.invalid/read");
  assert.equal(new Headers(calls[1].options.headers).has("X-SafAI-Relay"), false);
});

test("local blob previews keep their exact URL and never receive relay credentials", async t => {
  const { window, calls } = harness(t);
  const blobURL = "blob:http://127.0.0.1:43210/00000000-0000-4000-8000-000000000001";
  const image = window.document.createElement("img");
  image.src = blobURL;
  assert.equal(image.src, blobURL);
  const script = window.document.createElement("script");
  script.src = blobURL;
  assert.equal(script.src, blobURL);
  await window.fetch(blobURL);
  assert.equal(calls[0].url, blobURL);
  assert.equal(new Headers(calls[0].options.headers).has("X-SafAI-Relay"), false);
});

test("relay buffers uploads with a size limit and honors abort while reading", { timeout: 3000 }, async t => {
  const { window, calls } = harness(t);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(window.fetch(new Request("https://chatgpt.com/upload", { method: "POST", body: stream, duplex: "half" })), /32 MiB/);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
  const abort = new AbortController();
  const pending = window.fetch(new Request("https://chatgpt.com/upload", { method: "POST", body: new ReadableStream(), duplex: "half", signal: abort.signal }));
  abort.abort(new Error("test aborted"));
  await assert.rejects(pending, /test aborted/);
  assert.equal(calls.length, 0);
});

test("relay rejects oversized uploads without waiting for source cancellation", { timeout: 3000 }, async t => {
  const { window, calls } = harness(t);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  });
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("upload rejection waited for cancellation")), 100);
  });
  try {
    await assert.rejects(Promise.race([
      window.fetch(new Request("https://chatgpt.com/upload", { method: "POST", body, duplex: "half" })),
      timeout,
    ]), /32 MiB/);
  } finally { clearTimeout(deadline); }
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});
