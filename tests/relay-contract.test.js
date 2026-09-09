import test from "node:test";
import assert from "node:assert/strict";
import { relayState, relayProviderURL } from "../src/core/relay-contract.js";

const providerURL = `http://safai-provider-01234567-89ab-cdef-0123-456789abcdef.localhost:48123/?__safai_key=${"a".repeat(64)}`;
const signedIn = { ok: true, phase: "signedIn", revision: 4, message: "已登入", providerURL };

test("only canonical one-capability provider URLs are accepted", () => {
  assert.equal(relayProviderURL(providerURL).href, providerURL);
  for (const value of [providerURL.replace("http:", "https:"), providerURL.replace("provider-", "control-"), providerURL.replace(":48123", ""), providerURL + "&x=1", providerURL + "#x", providerURL + `&__safai_key=${"b".repeat(64)}`, providerURL.replace("/?", "/private?"), providerURL.replace("http://", "http://user:password@"), providerURL.replace(".localhost", ".localhost.evil.test"), providerURL.replace("48123", "80")]) {
    assert.throws(() => relayProviderURL(value));
  }
});

test("only confirmed signed-in state may carry a provider capability", () => {
  assert.deepEqual(relayState(signedIn), signedIn);
  assert.throws(() => relayState({ ...signedIn, phase: "signedOut" }));
  assert.throws(() => relayState({ ...signedIn, providerURL: undefined }));
  assert.deepEqual(relayState({ ok: true, phase: "restoring", message: "確認中", revision: 1 }), { ok: true, phase: "restoring", message: "確認中", revision: 1 });
});

test("relay state validates bounded fields and strips unknown native data", () => {
  for (const value of [null, { ok: false, error: "native details" }, { ...signedIn, phase: "unknown" }, { ...signedIn, revision: -1 }, { ...signedIn, revision: 1.5 }, { ...signedIn, message: "x".repeat(1025) }, { ...signedIn, providerURL: "https://chatgpt.com/" }]) {
    assert.throws(() => relayState(value));
  }
  assert.deepEqual(relayState({ ...signedIn, privateNativeField: "must-not-return" }), signedIn);
});
