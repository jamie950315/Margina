import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../src/relay/browser.js", import.meta.url), "utf8");
const key = "b".repeat(64);
function harness(t) {
  const dom = new JSDOM(`<script src="http://safai-provider-00000000-0000-4000-8000-000000000000.localhost:45678/__safai/bridge.js?__safai_key=${key}"></script><textarea id="prompt-textarea"></textarea><button type="submit">Send</button>`, {
    url: "http://safai-provider-00000000-0000-4000-8000-000000000000.localhost:45678/", runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const parent = {};
  Object.defineProperty(window, "parent", { value: parent });
  Object.defineProperty(window.document, "currentScript", { get: () => window.document.querySelector("script") });
  window.fetch = async () => { throw new Error("Draft bridge must not make network calls"); };
  window.Request = Request; window.Headers = Headers;
  window.eval(source);
  const messages = [];
  const port = { start() {}, close() {}, postMessage: message => messages.push(message) };
  function connect(overrides = {}) {
    window.dispatchEvent(new window.MessageEvent("message", {
      source: parent, origin: "safari-web-extension://01234567-89AB-CDEF-0123-456789ABCDEF",
      data: { type: "SAFAI_RELAY_CONNECT", key }, ports: [port], ...overrides,
    }));
  }
  async function send(data) {
    await port.onmessage?.({ data });
    await Promise.resolve();
    return messages.at(-1);
  }
  return { window, connect, send, messages, port, parent };
}

test("relay draft bridge only accepts the keyed extension parent", t => {
  const h = harness(t);
  h.connect({ origin: "https://page.example" });
  h.connect({ origin: "null" });
  h.connect({ source: {} });
  h.connect({ data: { type: "SAFAI_RELAY_CONNECT", key: "c".repeat(64) } });
  assert.equal(h.messages.length, 0);
  h.connect();
  assert.equal(h.messages[0]?.type, "READY");
});

test("relay prepares plain text without submitting, exporting data or replaying an operation", async t => {
  const h = harness(t);
  h.connect();
  let submitted = 0;
  h.window.document.querySelector("button").addEventListener("click", () => submitted++);
  const reply = await h.send({ type: "PREPARE_DRAFT", id: "one", text: "<script>untrusted</script>\n頁面摘要", attachments: [] });
  assert.equal(reply.ok, true);
  assert.equal(h.window.document.querySelector("textarea").value, "<script>untrusted</script>\n頁面摘要");
  assert.equal(submitted, 0);
  h.window.document.querySelector("textarea").value = "manually changed";
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "one", text: "replay", attachments: [] })).ok, true);
  assert.equal(h.window.document.querySelector("textarea").value, "manually changed");
  assert.equal(JSON.stringify(reply).includes("untrusted"), false);
});

test("relay preserves an existing provider draft and rejects malformed or oversized input", async t => {
  const h = harness(t);
  h.connect();
  const input = h.window.document.querySelector("textarea");
  input.value = "keep my draft";
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "busy", text: "new", attachments: [] })).ok, false);
  assert.equal(input.value, "keep my draft");
  input.value = "";
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "large", text: "x".repeat(196609), attachments: [] })).ok, false);
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "bad", text: "new", attachments: [{ dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }] })).ok, false);
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "many", text: "new", attachments: Array(9).fill({ dataUrl: "data:image/png;base64,YQ==" }) })).ok, false);
  assert.equal(input.value, "");
});

test("relay never drops requested files when provider upload controls are unavailable", async t => {
  const h = harness(t);
  h.connect();
  const reply = await h.send({ type: "PREPARE_DRAFT", id: "file", text: "image", attachments: [{ dataUrl: "data:image/png;base64,YQ==" }] });
  assert.equal(reply.ok, false);
  assert.equal(h.window.document.querySelector("textarea").value, "");
});

test("relay checks draft and upload readiness before decoding requested images", async t => {
  const h = harness(t);
  h.connect();
  let decodes = 0;
  const originalAtob = h.window.atob;
  h.window.atob = value => { decodes++; return originalAtob(value); };
  const editor = h.window.document.querySelector("textarea");
  const attachment = { dataUrl: "data:image/png;base64,YQ==" };
  editor.value = "keep my draft";
  const busy = await h.send({ type: "PREPARE_DRAFT", id: "busy_image", text: "image", attachments: [attachment] });
  assert.equal(busy.ok, false);
  assert.equal(decodes, 0, "a known occupied draft cannot receive images");
  assert.equal(editor.value, "keep my draft");
  editor.value = "";
  const unavailable = await h.send({ type: "PREPARE_DRAFT", id: "unavailable_image", text: "image", attachments: [attachment] });
  assert.equal(unavailable.ok, false);
  assert.equal(decodes, 0, "unavailable upload controls cannot receive images");
  assert.equal(editor.value, "");
});

test("relay selects the composer form upload instead of unrelated media and camera inputs", async t => {
  const h = harness(t);
  const { document } = h.window;
  const form = document.createElement("form");
  document.body.append(form);
  form.append(document.querySelector("textarea"));
  const upload = document.createElement("input");
  upload.type = "file"; upload.multiple = true;
  form.append(upload);
  let files = [], changed = 0;
  Object.defineProperty(upload, "files", { get: () => files, set: value => { files = value; } });
  upload.addEventListener("change", () => changed++);
  for (let i = 0; i < 4; i++) {
    const other = document.createElement("input");
    other.type = "file"; other.multiple = true; other.accept = "image/*";
    document.body.append(other);
    other.addEventListener("change", () => assert.fail("unrelated uploader must not receive files"));
  }
  h.window.DataTransfer = class {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  };
  h.connect();
  const reply = await h.send({ type: "PREPARE_DRAFT", id: "composer_file", text: "image", attachments: [{ dataUrl: "data:image/png;base64,YQ==" }] });
  assert.equal(reply.ok, true);
  assert.equal(changed, 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "SafAI-1.png");
  const ambiguous = document.createElement("input");
  ambiguous.type = "file"; ambiguous.multiple = true;
  form.append(ambiguous);
  document.querySelector("textarea").value = "";
  files = [];
  assert.equal((await h.send({ type: "PREPARE_DRAFT", id: "ambiguous_form", text: "new", attachments: [{ dataUrl: "data:image/png;base64,YQ==" }] })).ok, false);
  assert.equal(changed, 1);
});
