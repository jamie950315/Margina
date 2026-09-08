import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

function sharedBrowser() {
  const data = {};
  const listeners = new Set();
  const api = {
    runtime: { id: "test-extension", getURL: (path) => `https://extension.test/${path}` },
    permissions: { contains: async () => true, request: async () => true, remove: async () => true },
    storage: {
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      local: {
        get: async (key) => structuredClone({ [key]: data[key] }),
        set: async (update) => {
          await new Promise((resolve) => setImmediate(resolve));
          const changes = Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { oldValue: data[key], newValue: structuredClone(value) }]));
          Object.assign(data, structuredClone(update));
          for (const listener of listeners) listener(changes, "local");
        },
      },
    },
  };
  api.runtime.sendMessage = (message) => handleStorageMessage(message, { id: api.runtime.id, url: api.runtime.getURL("panel.html") }, api);
  return { api, data, listeners };
}

async function openPanel(t, shared) {
  const panel = await panelHarness({ demo: false, browser: shared.api });
  t.after(() => panel.dom.window.close());
  panel.connectBridge(() => ({ ok: true, page: { title: "Test", url: "https://fixture.example/", text: "Synthetic page" }, selection: "", contextRevision: 0 }));
  await panel.initialize();
  return panel;
}

function editSettings(panel, suffix) {
  panel.openSettings();
  panel.elements.baseUrlInput.value = `https://${suffix}.example/v1`;
  panel.elements.apiKeyInput.value = "synthetic-key";
  panel.elements.modelInput.value = `model-${suffix}`;
}

test("another panel's page or mode toggle cannot restore an old API configuration", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared), b = await openPanel(t, shared);
  editSettings(a, "new");
  await a.saveSettings({ preventDefault() {} });
  assert.equal(b.state.settings.model, "model-new", "settings sync to already-open panels");
  await b.toggleSetting("includePage", () => {}, "failed");
  await b.applyMode("chatgpt");
  assert.equal(shared.data.settings.baseUrl, "https://new.example/v1");
  assert.equal(shared.data.settings.apiKey, "synthetic-key");
  assert.equal(shared.data.settings.model, "model-new");
  assert.equal(shared.data.settings.includePage, false);
  const reopened = await openPanel(t, shared);
  assert.equal(reopened.state.settings.model, "model-new");
});

test("stale open API forms cannot overwrite another panel's newer changes", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared), b = await openPanel(t, shared);
  editSettings(b, "stale");
  shared.listeners.clear();
  editSettings(a, "new");
  await a.saveSettings({ preventDefault() {} });
  await b.saveSettings({ preventDefault() {} });
  assert.equal(shared.data.settings.model, "model-new");
  assert.match(b.elements.toast.textContent, /另一個頁面變更/);
  b.openSettings();
  assert.equal(b.elements.modelInput.value, "model-new", "reopening after conflict loads the current saved values");
});

test("a missed settings event cannot send a prompt using the old provider", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared), b = await openPanel(t, shared);
  shared.listeners.clear();
  editSettings(a, "new");
  await a.saveSettings({ preventDefault() {} });
  let requests = 0;
  b.dom.window.fetch = () => { requests++; throw new Error("old provider must not be called"); };
  b.elements.promptInput.value = "Synthetic question";
  await b.submitPrompt({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(b.state.settings.model, "model-new");
  assert.equal(b.elements.promptInput.value, "Synthetic question");
  assert.match(b.elements.toast.textContent, /另一頁更新/);
});

test("returning to an inactive panel refreshes settings even if a change event was missed", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared), b = await openPanel(t, shared);
  shared.listeners.clear();
  editSettings(a, "new");
  await a.saveSettings({ preventDefault() {} });
  b.dom.window.dispatchEvent(new b.dom.window.Event("focus"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.state.settings.model, "model-new");
});

test("simultaneous conversation saves keep both chats and survive a fresh panel", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared), b = await openPanel(t, shared);
  for (const [panel, id] of [[a, "A"], [b, "B"]]) {
    panel.state.activeConversationId = id;
    panel.state.history = [{ role: "user", content: id }, { role: "assistant", content: `Answer ${id}` }];
  }
  await Promise.all([a.saveActiveConversation(), b.saveActiveConversation()]);
  assert.equal(shared.data.conversations.conversations.length, 2);
  const reopened = await openPanel(t, shared);
  assert.equal(reopened.state.conversations.length, 2);
  await a.newConversation();
  assert.equal(shared.data.conversations.conversations.length, 2);
});

test("two panels adding turns to the same saved conversation lose neither turn", async (t) => {
  const shared = sharedBrowser();
  const a = await openPanel(t, shared);
  a.state.history = [{ role: "user", content: "initial" }, { role: "assistant", content: "initial answer" }];
  await a.saveActiveConversation();
  const b = await openPanel(t, shared);
  a.state.history.push({ role: "user", content: "A" }, { role: "assistant", content: "answer A" });
  b.state.history.push({ role: "user", content: "B" }, { role: "assistant", content: "answer B" });
  await Promise.all([a.saveActiveConversation(), b.saveActiveConversation()]);
  const messages = shared.data.conversations.conversations[0].messages;
  assert.equal(messages.length, 6);
  assert.ok(messages.some((m) => m.content === "answer A"));
  assert.ok(messages.some((m) => m.content === "answer B"));
});

test("content scripts and webpages cannot invoke storage mutations or receive keys", async () => {
  const { api, data } = sharedBrowser();
  for (const sender of [{ id: api.runtime.id, url: "https://fixture.example/" }, { id: "wrong-extension", url: api.runtime.getURL("panel.html") }, {}]) {
    const response = await handleStorageMessage({ type: "PATCH_SETTINGS", patch: { model: "bad" } }, sender, api);
    assert.equal(response.ok, false);
    assert.equal(response.settings, undefined);
    assert.equal(data.settings, undefined);
  }
});

test("queued saves recheck permissions after another save removes an old origin", async () => {
  const { api, data } = sharedBrowser();
  data.settings = { ...DEFAULT_SETTINGS, baseUrl: "https://a.example/v1" };
  const allowed = new Set(["https://a.example/*", "https://b.example/*"]);
  let started, release;
  const removing = new Promise((resolve) => { started = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  api.permissions.contains = async ({ origins }) => allowed.has(origins[0]);
  api.permissions.remove = async ({ origins }) => {
    started();
    await delayed;
    return allowed.delete(origins[0]);
  };
  const first = api.runtime.sendMessage({ type: "PATCH_SETTINGS", patch: { baseUrl: "https://b.example/v1" }, expected: { baseUrl: "https://a.example/v1" } });
  await removing;
  const second = api.runtime.sendMessage({ type: "PATCH_SETTINGS", patch: { baseUrl: "https://a.example/v1" }, expected: { baseUrl: "https://b.example/v1" } });
  release();
  assert.equal((await first).ok, true);
  const rejected = await second;
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /授權已變更/);
  assert.equal(data.settings.baseUrl, "https://b.example/v1");
  assert.equal(allowed.has("https://b.example/*"), true);
});
