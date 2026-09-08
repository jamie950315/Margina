import test from "node:test";
import assert from "node:assert/strict";
import { handleReadingMessage } from "../src/background/tabs.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

function fixture() {
  const calls = [];
  const tabs = [
    { id: 1, windowId: 7, url: "https://example.com/a?private=yes#section", title: "Article", active: true },
    { id: 2, windowId: 7, url: "https://example.org/b", title: "Second" },
    { id: 3, windowId: 7, url: "https://private.example/", incognito: true },
    { id: 4, windowId: 7, url: "safari://settings" },
    { id: 5, windowId: 8, url: "https://other.example/" },
  ];
  const api = {
    runtime: { id: "safai", getURL: (path) => `safari-web-extension://safai/${path}` },
    storage: { local: { async get() { return { settings: { selectionTools: false, apiKey: "never-return" } }; } } },
    permissions: { async contains() { return true; } },
    tabs: {
      async query(query) { return tabs.filter((tab) => tab.windowId === (query.windowId ?? 7) && (!query.active || tab.active)); },
      async get(id) { return { ...tabs.find((tab) => tab.id === id) }; },
      async update(id, patch) { calls.push({ id, patch }); },
    },
    scripting: { async executeScript(options) {
      calls.push(options);
      if (options.files) return [{ frameId: 0 }];
      if (options.args) return [{ frameId: 0, result: { ok: true } }];
      return [{ frameId: 0, result: { title: "Article", url: options.target.tabId === 1 ? "https://example.com/a" : "https://example.org/b", text: "A".repeat(20_000) } }];
    } },
  };
  const sender = { id: "safai", url: api.runtime.getURL("panel.html"), tab: tabs[0] };
  return { api, sender, tabs, calls };
}

test("Safari permission match patterns exclude ports while page URLs retain them", async () => {
  const { api, sender, tabs } = fixture();
  tabs[0].url = "http://127.0.0.1:8767/one";
  const patterns = [];
  api.permissions.contains = async ({ origins }) => { patterns.push(...origins); return true; };
  api.scripting.executeScript = async options => options.files ? [{ frameId: 0 }] : [{ frameId: 0, result: { title: "Test", url: tabs[0].url, text: "Test text" } }];
  const result = await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: tabs[0].url }] }, sender, api);
  assert.equal(result.ok, true);
  assert.equal(result.pages[0].url, "http://127.0.0.1:8767/one");
  assert.ok(patterns.every(value => value === "http://127.0.0.1/*"));
});

test("reading tab list returns only sanitized current-window metadata, never injects", async () => {
  const { api, sender, calls } = fixture();
  const result = await handleReadingMessage({ type: "LIST_READING_TABS" }, sender, api);
  assert.equal(result.ok, true);
  assert.deepEqual(result.tabs, [
    { id: 1, title: "Article", url: "https://example.com/a" },
    { id: 2, title: "Second", url: "https://example.org/b" },
  ]);
  assert.equal(calls.length, 0);
  delete sender.tab;
  assert.equal((await handleReadingMessage({ type: "LIST_READING_TABS" }, sender, api)).ok, true);
});

test("privileged reading operations reject webpage, foreign, and non-panel senders", async () => {
  const { api, sender, calls } = fixture();
  for (const patch of [{ url: "https://example.com/a" }, { id: "foreign" }, { url: api.runtime.getURL("other.html") }, { tab: { id: 3, incognito: true } }]) {
    for (const type of ["LIST_READING_TABS", "READ_READING_TABS", "LOCATE_TAB_SOURCE", "PREPARE_LONG_TABS", "READ_LONG_TAB_BATCH", "VALIDATE_LONG_TAB", "RELEASE_LONG_TAB"]) {
      assert.equal((await handleReadingMessage({ type }, { ...sender, ...patch }, api)).ok, false);
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(handleReadingMessage({ type: "UNRELATED" }, sender, api), undefined);
});

test("reading uses only a reader bundle and caps every page", async () => {
  const { api, sender, calls } = fixture();
  const result = await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }, { id: 2, url: "https://example.org/b" }] }, sender, api);
  assert.equal(result.ok, true);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].text.length, 16_000);
  assert.equal(result.pages[0].truncated, true);
  assert.equal(result.pages[0].originalChars, 20_000);
  assert.equal(result.pages[0].tabId, 1);
  assert.equal(result.pages[0].url, "https://example.com/a");
  assert.deepEqual(calls[0].files, ["reader-script.js"]);
});

test("comparison context preserves reader truncation and validates original character metadata", async () => {
  for (const [textLength, metadata, originalChars, truncated] of [
    [32_000, { originalChars: 70_000, truncated: true }, 70_000, true],
    [16_000, { originalChars: 16_000, truncated: false }, 16_000, false],
    [100, { originalChars: 100, truncated: true }, 100, true],
    [100, {}, 100, false],
    [100, { originalChars: -5 }, 100, false],
    [100, { originalChars: "70000" }, 100, false],
    [100, { originalChars: Infinity }, 100, false],
    [100, { originalChars: 50 }, 100, false],
  ]) {
    const { api, sender } = fixture();
    api.scripting.executeScript = async options => options.files ? [{ frameId: 0 }] : [{ frameId: 0, result: {
      title: "Article", url: "https://example.com/a", text: "A".repeat(textLength), ...metadata,
    } }];
    const result = await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }] }, sender, api);
    assert.equal(result.ok, true);
    assert.equal(result.pages[0].text.length, Math.min(textLength, 16_000));
    assert.equal(result.pages[0].originalChars, originalChars);
    assert.equal(result.pages[0].truncated, truncated);
  }
});

test("reading rejects duplicate, excessive, private, moved, missing and changed selections", async () => {
  const { api, sender } = fixture();
  for (const items of [[], Array(4).fill({ id: 1, url: "https://example.com/a" }), [{ id: 1, url: "https://example.com/a" }, { id: 1, url: "https://example.com/a" }], [{ id: 3, url: "https://private.example/" }], [{ id: 5, url: "https://other.example/" }], [{ id: 99, url: "https://example.com/" }], [{ id: 1, url: "https://example.com/changed" }]]) {
    assert.equal((await handleReadingMessage({ type: "READ_READING_TABS", items }, sender, api)).ok, false);
  }
});

test("navigation including query-only navigation fails the entire read", async () => {
  const { api, sender, tabs } = fixture();
  const original = api.scripting.executeScript;
  api.scripting.executeScript = async (options) => {
    const result = await original(options);
    if (options.func) tabs[0].url = "https://example.com/a?changed=1";
    return result;
  };
  const result = await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }] }, sender, api);
  assert.equal(result.ok, false);
  assert.equal(result.pages, undefined);
});

test("a first page changing during a later read rejects the complete batch", async () => {
  const { api, sender, tabs } = fixture();
  const original = api.scripting.executeScript;
  api.scripting.executeScript = async (options) => {
    const result = await original(options);
    if (options.func && options.target.tabId === 2) tabs[0].url += "changed";
    return result;
  };
  const result = await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }, { id: 2, url: "https://example.org/b" }] }, sender, api);
  assert.equal(result.ok, false);
  assert.equal(result.pages, undefined);
});

test("a replaced document with unchanged URL is rejected when document IDs are available", async () => {
  const { api, sender } = fixture();
  const original = api.scripting.executeScript;
  api.scripting.executeScript = async (options) => (await original(options)).map((entry) => ({ ...entry, documentId: options.files ? "original" : "replacement" }));
  assert.equal((await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }] }, sender, api)).ok, false);
});

test("revoked permissions, missing script result and empty page fail explicitly", async () => {
  for (const kind of ["permission", "missing", "empty"]) {
    const { api, sender } = fixture();
    if (kind === "permission") api.permissions.contains = async () => false;
    else api.scripting.executeScript = async () => kind === "missing" ? [] : [{ frameId: 0, result: { title: "", text: " ", url: "https://example.com/a" } }];
    assert.equal((await handleReadingMessage({ type: "READ_READING_TABS", items: [{ id: 1, url: "https://example.com/a" }] }, sender, api)).ok, false);
  }
});

test("location activates a matching tab only after successful explicit location", async () => {
  const { api, sender, calls } = fixture();
  const result = await handleReadingMessage({ type: "LOCATE_TAB_SOURCE", tabId: 2, url: "https://example.org/b", quote: "An original sentence" }, sender, api);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1), { id: 2, patch: { active: true } });
  assert.equal((await handleReadingMessage({ type: "LOCATE_TAB_SOURCE", tabId: 2, url: "https://example.org/wrong", quote: "An original sentence" }, sender, api)).ok, false);
});

test("missing original text does not activate a different tab", async () => {
  const { api, sender, calls } = fixture();
  const original = api.scripting.executeScript;
  api.scripting.executeScript = async (options) => options.args ? [{ frameId: 0, result: { ok: false } }] : original(options);
  const result = await handleReadingMessage({ type: "LOCATE_TAB_SOURCE", tabId: 2, url: "https://example.org/b", quote: "Missing sentence" }, sender, api);
  assert.equal(result.ok, false);
  assert.match(result.error, /找不到原文/);
  assert.ok(!calls.some((call) => call.patch));
});

test("content preference read returns only a boolean and rejects subframes and foreign senders", async () => {
  const { api, tabs } = fixture();
  const sender = { id: api.runtime.id, url: tabs[0].url, tab: tabs[0], frameId: 0 };
  assert.deepEqual(await handleReadingMessage({ type: "GET_READING_PREFERENCES" }, sender, api), { ok: true, selectionTools: false });
  for (const patch of [{ frameId: 1 }, { id: "foreign" }, { url: "https://other.example/" }]) {
    assert.equal((await handleReadingMessage({ type: "GET_READING_PREFERENCES" }, { ...sender, ...patch }, api)).ok, false);
  }
  api.storage.local.get = async () => { throw new Error("private implementation failure"); };
  const result = await handleReadingMessage({ type: "GET_READING_PREFERENCES" }, sender, api);
  assert.equal(result.ok, false);
  assert.ok(!result.error.includes("private implementation"));
});

test("changing API endpoints never removes mandatory all-site reading access", async () => {
  const { api, sender } = fixture();
  let settings = { ...DEFAULT_SETTINGS, baseUrl: "https://old.example/v1" };
  const checked = [];
  api.runtime.getManifest = () => ({ host_permissions: ["http://*/*", "https://*/*"] });
  api.storage.local.get = async () => ({ settings: { ...settings } });
  api.storage.local.set = async update => { settings = update.settings; };
  api.permissions.contains = async value => { checked.push(value); return true; };
  api.permissions.remove = async () => { assert.fail("mandatory shared site permission must not be removed"); };
  const result = await handleStorageMessage({
    type: "PATCH_SETTINGS", patch: { baseUrl: "https://new.example/v1" }, expected: { baseUrl: "https://old.example/v1" },
  }, sender, api);
  assert.equal(result.ok, true);
  assert.equal(result.warning, "");
  assert.equal(settings.baseUrl, "https://new.example/v1");
  assert.deepEqual(checked, [{ origins: ["https://new.example/*"] }]);
});

test("long-tab preparation returns bounded plans only and rechecks each snapshot", async () => {
  const { api, sender, calls } = fixture();
  api.scripting.executeScript = async options => {
    calls.push(options);
    if (options.files) return [{ frameId: 0 }];
    if (options.args[0].snapshotId) return [{ frameId: 0, result: { ok: true } }];
    assert.equal(options.args[0].budgetChars, 16_000);
    return [{ frameId: 0, result: { snapshotId: "a".repeat(32), url: "https://example.com/a", totalChars: 1_000_000, batchCount: 84, context: { sources: [] } } }];
  };
  const result = await handleReadingMessage({ type: "PREPARE_LONG_TABS", items: [{ id: 1, url: "https://example.com/a" }], query: "tail", budgetChars: 9_000_000 }, sender, api);
  assert.equal(result.ok, true);
  assert.equal(result.plans[0].tabId, 1);
  assert.equal(result.plans[0].text, undefined);
  assert.equal(calls.filter(call => call.func).length, 2);
});

test("long-tab batch routes reject stale snapshots, revoked access and changed navigation", async () => {
  for (const failure of ["snapshot", "permission", "navigation", "private", "moved", "invalid-index"]) {
    const { api, sender, tabs } = fixture();
    if (failure === "permission") api.permissions.contains = async () => false;
    if (failure === "private") tabs[1].incognito = true;
    if (failure === "moved") tabs[1].windowId = 99;
    api.scripting.executeScript = async options => {
      if (options.files) return [{ frameId: 0 }];
      if (failure === "snapshot") throw new Error("private URL leaked by browser");
      if (failure === "navigation") tabs[1].url += "?changed=yes";
      return [{ frameId: 0, result: { index: 0, sources: [] } }];
    };
    const result = await handleReadingMessage({ type: "READ_LONG_TAB_BATCH", tabId: 2, url: "https://example.org/b", snapshotId: "a".repeat(32), index: failure === "invalid-index" ? -1 : 0 }, sender, api);
    assert.equal(result.ok, false, failure);
    assert.equal(result.batch, undefined);
    assert.ok(!result.error.includes("private URL"));
  }
});
