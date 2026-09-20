import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { panelHarness } from "./helpers/panel-harness.js";

async function fixture(t) {
  let writes = 0;
  const browser = {
    runtime: { getManifest: () => ({ host_permissions: ["http://*/*", "https://*/*"] }), sendMessage: async () => { writes++; throw new Error("unexpected write"); } },
    permissions: { contains: async () => true },
  };
  const panel = await panelHarness({ demo: false, browser });
  t.after(() => panel.dom.window.close());
  panel.openSettings();
  panel.elements.baseUrlInput.value = "https://provider.example/custom/v1";
  panel.elements.apiKeyInput.value = "synthetic-key";
  panel.elements.modelInput.value = "form-model";
  return { ...panel, browser, writes: () => writes };
}

test("settings has separate validation and save buttons without the removed privacy note", async t => {
  const p = await fixture(t);
  const actions = p.dom.window.document.querySelector(".settings-actions");
  assert.deepEqual([...actions.children].map(x => [x.type, x.textContent]), [["button", "驗證 API Key"], ["submit", "儲存設定"]]);
  assert.equal(p.dom.window.document.querySelector(".security-note"), null);
  assert.ok(!p.elements.settingsForm.textContent.includes("檢查權限"));
});

test("validation sends only a fixed prompt using unsaved form credentials, never writes settings", async t => {
  const p = await fixture(t);
  const before = JSON.stringify(p.state.settings);
  p.state.history = [{ role: "user", content: "private history" }];
  let requests = 0;
  p.dom.window.fetch = async (url, options) => {
    requests++;
    assert.equal(url, "https://provider.example/custom/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer synthetic-key");
    assert.deepEqual(JSON.parse(options.body), { model: "form-model", messages: [{ role: "user", content: "Reply with OK only." }], stream: false });
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(p.elements.validateKeyButton.disabled, true);
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
  };
  await p.validateSettings();
  assert.equal(requests, 1);
  assert.equal(p.writes(), 0);
  assert.equal(JSON.stringify(p.state.settings), before);
  assert.match(p.elements.validationStatus.textContent, /驗證成功.*尚未儲存/);
  assert.equal(p.elements.validateKeyButton.disabled, false);
});

test("validation errors do not echo provider bodies or retry", async t => {
  const p = await fixture(t);
  let requests = 0;
  p.dom.window.fetch = async () => { requests++; return new Response(JSON.stringify({ error: { message: "synthetic-key private diagnostic" } }), { status: 401 }); };
  await p.validateSettings();
  assert.equal(requests, 1);
  assert.match(p.elements.validationStatus.textContent, /HTTP 401/);
  assert.ok(!p.elements.validationStatus.textContent.includes("synthetic-key"));
  assert.equal(p.writes(), 0);
});

test("save persists settings without making a validation request", async t => {
  const p = await fixture(t);
  p.openSettings();
  p.dom.window.fetch = () => assert.fail("saving must not call the provider");
  let saves = 0;
  p.browser.runtime.sendMessage = async message => {
    assert.equal(message.type, "PATCH_SETTINGS");
    saves++;
    return { ok: true, settings: { ...p.state.settings, ...message.patch } };
  };
  await p.saveSettings({ preventDefault() {} });
  assert.equal(saves, 1);
  assert.match(p.elements.toast.textContent, /已儲存/);
});

test("missing permission and insecure key destinations block validation before fetch", async t => {
  const p = await fixture(t);
  p.dom.window.fetch = () => assert.fail("must not send");
  p.browser.permissions.contains = async () => false;
  await p.validateSettings();
  assert.match(p.elements.validationStatus.textContent, /未允許/);
  p.elements.baseUrlInput.value = "http://127.0.0.1:1234/v1";
  await p.validateSettings();
  assert.match(p.elements.validationStatus.textContent, /HTTPS/);
});

test("closing settings aborts the single validation request and releases busy state", async t => {
  const p = await fixture(t);
  let start;
  const started = new Promise(resolve => { start = resolve; });
  p.dom.window.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    start();
  });
  const pending = p.validateSettings();
  await started;
  await p.validateSettings();
  p.closeSettings();
  await pending;
  p.openSettings();
  assert.equal(p.elements.validationStatus.hidden, true);
  assert.equal(p.elements.validateKeyButton.disabled, false);
});

test("validation completes a real loopback HTTP request without credentials or persistence", async t => {
  const p = await fixture(t);
  let received;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  p.elements.baseUrlInput.value = `http://127.0.0.1:${server.address().port}/v1`;
  p.elements.apiKeyInput.value = "";
  p.dom.window.fetch = fetch;
  await p.validateSettings();
  assert.equal(received.url, "/v1/chat/completions");
  assert.equal(received.authorization, undefined);
  assert.equal(received.body.model, "form-model");
  assert.match(p.elements.validationStatus.textContent, /驗證成功/);
  assert.equal(p.writes(), 0);
});
