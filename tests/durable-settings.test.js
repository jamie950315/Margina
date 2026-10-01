import test from "node:test";
import assert from "node:assert/strict";
import { createDurableSettings } from "../src/background/durable-settings.js";
import { createSharedStore } from "../src/core/shared-store.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { handleReadingMessage } from "../src/background/tabs.js";
import { panelHarness } from "./helpers/panel-harness.js";

function fixture() {
  let persisted = null;
  const local = {};
  const calls = [];
  const listeners = new Set();
  const api = {
    runtime: {
      id: "synthetic",
      getURL: path => `safari-web-extension://synthetic/${path}`,
      sendNativeMessage: async (application, message) => {
        assert.equal(application, "dev.jamie.safai");
        calls.push(message.action);
        if (message.action === "settings.read") return { ok: true, settings: structuredClone(persisted) };
        if (JSON.stringify(message.expected) !== JSON.stringify(persisted)) return { ok: false, code: "SETTINGS_CONFLICT" };
        persisted = structuredClone(message.settings);
        return { ok: true, settings: structuredClone(persisted) };
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    storage: { onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, local: {
      get: async key => ({ [key]: structuredClone(local[key]) }),
      set: async data => {
        Object.assign(local, structuredClone(data));
        for (const fn of listeners) fn(Object.fromEntries(Object.entries(data).map(([key, newValue]) => [key, { newValue }])), "local");
      },
    } },
  };
  api.runtime.sendMessage = message => handleStorageMessage(message, { id: api.runtime.id, url: api.runtime.getURL("panel.html") }, api);
  return { api, local, calls, saved: () => persisted };
}

test("API settings survive complete loss of browser storage and a fresh writer", async () => {
  const f = fixture();
  f.local.settings = { ...DEFAULT_SETTINGS, apiKey: "synthetic-key", model: "saved-model" };
  const first = createSharedStore(f.api.storage.local, createDurableSettings(f.api));
  assert.equal((await first.readSettings()).model, "saved-model");
  await first.patchSettings({ model: "updated-model" });
  delete f.local.settings;
  const reopened = createSharedStore(f.api.storage.local, createDurableSettings(f.api));
  const settings = await reopened.readSettings();
  assert.equal(settings.apiKey, "synthetic-key");
  assert.equal(settings.model, "updated-model");
  assert.equal(f.local.settings, undefined, "native saves do not mirror secrets back to browser storage");
});

test("website exceptions persist through the native writer without changing provider settings", async () => {
  const f = fixture();
  f.local.settings = { ...DEFAULT_SETTINGS, apiKey: "synthetic-key", model: "saved-model" };
  const first = createSharedStore(f.api.storage.local, createDurableSettings(f.api));
  await first.patchSettings({ selectionToolsDisabledSites: "chatgpt.com" }, { selectionToolsDisabledSites: "" });
  delete f.local.settings;
  const reopened = createSharedStore(f.api.storage.local, createDurableSettings(f.api));
  const settings = await reopened.readSettings();
  assert.equal(settings.selectionToolsDisabledSites, "chatgpt.com");
  assert.equal(settings.apiKey, "synthetic-key");
  assert.equal(settings.model, "saved-model");
  assert.equal(settings.selectionTools, true);
});

test("concurrent first imports preserve the winning native settings", async () => {
  const f = fixture();
  f.local.settings = { ...DEFAULT_SETTINGS, model: "migrated-model" };
  const results = await Promise.all([createDurableSettings(f.api).read(), createDurableSettings(f.api).read()]);
  assert.ok(results.every(settings => settings.model === "migrated-model"));
});

test("Safari panel reads native settings, saves without a secret mirror, and refreshes other panels", async t => {
  const f = fixture();
  const panels = [];
  for (let i = 0; i < 2; i++) {
    const panel = await panelHarness({ demo: false, browser: f.api, url: f.api.runtime.getURL("panel.html") + "#bridge=test-token" });
    t.after(() => panel.dom.window.close());
    panel.connectBridge(() => ({ ok: true, page: { title: "Test", url: "https://fixture.example/", text: "Synthetic" }, selection: "", contextRevision: 0 }));
    await panel.initialize();
    panels.push(panel);
  }
  const [a, b] = panels;
  a.openSettings();
  a.elements.apiKeyInput.value = "synthetic-key";
  a.elements.modelInput.value = "native-model";
  await a.saveSettings({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.saved().model, "native-model");
  assert.equal(f.local.settings, undefined);
  assert.equal(typeof f.local.settingsRevision, "string");
  assert.equal(b.state.settings.model, "native-model");
  delete f.local.settingsRevision;
  b.dom.window.dispatchEvent(new b.dom.window.Event("focus"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.state.settings.apiKey, "synthetic-key");
});

test("native settings are never returned to content, foreign or private-tab senders", async () => {
  const f = fixture();
  for (const sender of [
    { id: "synthetic", url: "https://fixture.example/" },
    { id: "foreign", url: f.api.runtime.getURL("panel.html") },
    { id: "synthetic", url: f.api.runtime.getURL("panel.html"), tab: { incognito: true } },
  ]) {
    for (const type of ["GET_SETTINGS", "PATCH_SETTINGS"]) {
      const response = await handleStorageMessage({ type, patch: { model: "bad" } }, sender, f.api);
      assert.equal(response.ok, false);
      assert.equal(response.settings, undefined);
    }
  }
  assert.equal(f.calls.length, 0);
  const tab = { id: 1, url: "https://fixture.example/" };
  const response = await handleReadingMessage({ type: "GET_READING_PREFERENCES" },
    { id: "synthetic", url: tab.url, tab, frameId: 0 }, f.api);
  assert.deepEqual(response, { ok: true, selectionTools: true });
});

test("existing native settings win over stale legacy browser settings", async () => {
  const f = fixture();
  const durable = createDurableSettings(f.api);
  const initial = await durable.read();
  await durable.write({ ...initial, model: "native-model" }, initial);
  f.local.settings = { ...DEFAULT_SETTINGS, model: "stale" };
  assert.equal((await createDurableSettings(f.api).read()).model, "native-model");
});

test("native failure is explicit and never falls back to legacy settings", async () => {
  const f = fixture();
  f.local.settings = { ...DEFAULT_SETTINGS, apiKey: "synthetic-key" };
  f.api.runtime.sendNativeMessage = async () => { throw new Error("private diagnostic"); };
  await assert.rejects(createDurableSettings(f.api).read(), error => !error.message.includes("private diagnostic"));
  assert.equal(f.saved(), null);
});

test("incomplete native settings never become silent defaults", async () => {
  const f = fixture();
  f.api.runtime.sendNativeMessage = async () => ({ ok: true, settings: {} });
  await assert.rejects(createDurableSettings(f.api).read());
});

test("native compare-and-swap rejects a stale independent writer", async () => {
  const f = fixture();
  const a = createDurableSettings(f.api), b = createDurableSettings(f.api);
  const initial = await a.read();
  await b.write({ ...initial, model: "new" }, initial);
  await assert.rejects(a.write({ ...initial, model: "old" }, initial), { code: "SETTINGS_CONFLICT" });
  assert.equal((await a.read()).model, "new");
});

test("callback-only Safari native transport waits for acknowledgement and consumes lastError", async () => {
  const f = fixture();
  let callback;
  f.api.runtime.sendNativeMessage = (_app, _message, fn) => { callback = fn; };
  const pending = createDurableSettings(f.api).read();
  callback({ ok: true, settings: DEFAULT_SETTINGS });
  assert.equal((await pending).model, DEFAULT_SETTINGS.model);
  const failure = createDurableSettings(f.api).read();
  f.api.runtime.lastError = { message: "private native diagnostic" };
  callback(undefined);
  await assert.rejects(failure, error => !error.message.includes("private native diagnostic"));
});
