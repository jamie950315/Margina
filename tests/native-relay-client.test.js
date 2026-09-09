import test from "node:test";
import assert from "node:assert/strict";
import { sendNativeRelayCommand } from "../src/panel/native-relay-client.js";

const location = "safari-web-extension://safai-test/panel.html#bridge=fixture";
const signedOut = { ok: true, phase: "signedOut", revision: 1, message: "已登出" };
const signedIn = { ok: true, phase: "signedIn", revision: 2, message: "已登入", providerURL: `http://safai-provider-01234567-89ab-cdef-0123-456789abcdef.localhost:48123/?__safai_key=${"a".repeat(64)}` };
function fixture(invoke) {
  const calls = [];
  const api = { runtime: { id: "safai-test", getURL: path => `safari-web-extension://safai-test/${path}`, sendNativeMessage(...args) { calls.push(args); return invoke(...args); } } };
  return { api, calls };
}

test("Safari callback-only native messaging completes without a background hop", async () => {
  const { api, calls } = fixture((application, message, callback) => { queueMicrotask(() => callback(signedIn)); });
  assert.deepEqual(await sendNativeRelayCommand(api, "status", location), signedIn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "dev.jamie.safai");
  assert.deepEqual(calls[0][1], { action: "status" });
  assert.equal(typeof calls[0][2], "function");
});

test("Promise-only native APIs complete using the same single invocation", async () => {
  const { api, calls } = fixture(async () => signedOut);
  assert.deepEqual(await sendNativeRelayCommand(api, "logout", location), signedOut);
  assert.equal(calls.length, 1);
});

test("mixed callback and Promise results settle once without replaying a mutation", async () => {
  const { api, calls } = fixture((_, message, callback) => {
    callback(signedOut);
    return Promise.resolve(signedIn);
  });
  assert.deepEqual(await sendNativeRelayCommand(api, "switch", location), signedOut);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { action: "switch" });
  const laterError = fixture((_, message, callback) => { callback(signedOut); return Promise.reject(new Error("private late rejection")); });
  assert.deepEqual(await sendNativeRelayCommand(laterError.api, "login", location), signedOut);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(laterError.calls.length, 1);
});

test("wrong origins, non-panel pages, unsupported actions and missing native API make no call", async () => {
  const { api, calls } = fixture(() => { throw new Error("must not call"); });
  for (const url of ["https://example.com/panel.html", "safari-web-extension://other/panel.html", "safari-web-extension://safai-test/content.html", "invalid", "safari-web-extension://user:password@safai-test/panel.html"]) {
    await assert.rejects(sendNativeRelayCommand(api, "status", url));
  }
  await assert.rejects(sendNativeRelayCommand(api, "exportCookies", location));
  await assert.rejects(sendNativeRelayCommand({ runtime: { id: "test" } }, "status", location));
  assert.equal(calls.length, 0);
});

test("callback lastError, thrown errors and malformed responses never expose native details", async () => {
  const secret = signedIn.providerURL;
  let callback;
  const { api } = fixture((_, message, cb) => { callback = cb; });
  const operation = sendNativeRelayCommand(api, "status", location);
  api.runtime.lastError = { message: `sensitive ${secret}` };
  callback(signedIn);
  await assert.rejects(operation, error => !error.message.includes(secret) && /草稿仍保留/.test(error.message));
  for (const invoke of [() => { throw new Error(secret); }, () => Promise.reject(new Error(secret)), (_, message, cb) => cb({ ok: false, error: secret }), (_, message, cb) => cb({ ...signedIn, providerURL: "https://evil.test" }), (_, message, cb) => cb(null)]) {
    const next = fixture(invoke);
    await assert.rejects(sendNativeRelayCommand(next.api, "reconnect", location), error => !error.message.includes(secret) && !error.message.includes("evil.test"));
    assert.equal(next.calls.length, 1);
  }
});

test("a Promise response winning before a later callback cannot change the settled account state", async () => {
  let callback;
  const { api, calls } = fixture((_, message, cb) => { callback = cb; return Promise.resolve(signedOut); });
  const result = await sendNativeRelayCommand(api, "logout", location);
  callback(signedIn);
  assert.deepEqual(result, signedOut);
  assert.equal(calls.length, 1);
});
