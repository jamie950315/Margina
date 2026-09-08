import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { handleStorageMessage } from "../src/background/storage.js";

for (const operation of ["loadSettings", "loadConversationStore"]) {
  test(`${operation} reports unavailable storage instead of replacing saved data`, async (t) => {
    const failure = new Error("storage unavailable");
    const panel = await panelHarness({ demo: false, browser: {
      runtime: { id: "test-extension" },
      storage: { local: { get: async () => { throw failure; } } },
    } });
    t.after(() => panel.dom.window.close());
    await assert.rejects(panel[operation](), /storage unavailable/);
  });
}

test("missing extension APIs do not silently activate demo mode", async (t) => {
  const panel = await panelHarness({ demo: false });
  t.after(() => panel.dom.window.close());
  await assert.rejects(panel.initialize(), /擴充功能/);
});

test("clipboard denial is reported without trying another clipboard operation", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  let legacyCalls = 0;
  panel.dom.window.document.execCommand = () => { legacyCalls++; return true; };
  Object.defineProperty(panel.dom.window.navigator, "clipboard", { value: {
    writeText: async () => { throw new Error("clipboard denied"); },
  } });
  assert.equal(await panel.copyText("test"), false);
  assert.equal(legacyCalls, 0);
  assert.match(panel.elements.toast.textContent, /複製/);
});

test("image copy failure never starts an unsolicited download", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  let downloads = 0;
  panel.dom.window.HTMLAnchorElement.prototype.click = () => downloads++;
  await panel.copyAttachmentImage({ dataUrl: "data:image/png;base64,AA==", kind: "viewport" });
  assert.equal(downloads, 0);
  assert.match(panel.elements.toast.textContent, /複製/);
});

test("error notices remain visible until dismissed", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  const scheduled = [];
  panel.dom.window.setTimeout = (fn, ms) => scheduled.push(ms);
  panel.showToast("operation failed", "error");
  assert.deepEqual(scheduled, []);
});

test("starting a new conversation persists the selection without deleting history", async (t) => {
  let saved;
  const conversations = [{ id: "old", title: "old", updatedAt: 0, messages: [{ role: "user", content: "old" }] }];
  const browser = {
    runtime: { id: "test-extension", getURL: () => "https://extension.test/panel.html" },
    storage: { local: {
      get: async () => ({ conversations: { conversations, activeConversationId: "old" } }),
      set: async (value) => { saved = value; },
    } },
  };
  browser.runtime.sendMessage = (message) => handleStorageMessage(message, { id: browser.runtime.id, url: browser.runtime.getURL() }, browser);
  const panel = await panelHarness({ demo: false, browser });
  t.after(() => panel.dom.window.close());
  panel.state.activeConversationId = "old";
  panel.state.conversations = [{ id: "old", title: "old", updatedAt: 0, messages: [{ role: "user", content: "old" }] }];
  await panel.newConversation();
  assert.notEqual(saved?.conversations.activeConversationId, "old");
  assert.equal(saved?.conversations.conversations.length, 1);
});

test("failed page reads prevent sending a question without the requested context", async (t) => {
  const panel = await panelHarness({ demo: false, browser: {
    runtime: { id: "test-extension" },
    permissions: { request: async () => true, contains: async () => true },
    storage: { local: { get: async () => ({}) } },
  } });
  t.after(() => panel.dom.window.close());
  panel.connectBridge(() => ({ ok: false, error: "page read failed" }));
  let requests = 0;
  panel.dom.window.fetch = () => { requests++; };
  panel.elements.promptInput.value = "請閱讀頁面";
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(requests, 0);
  assert.equal(panel.elements.promptInput.value, "請閱讀頁面");
  assert.match(panel.elements.toast.textContent, /page read failed/);
  assert.equal(panel.elements.sendButton.disabled, false);
});

test("failed initialization leaves saved settings untouched and does not bind send", async (t) => {
  let writes = 0;
  const panel = await panelHarness({ demo: false, browser: {
    runtime: { id: "test-extension" },
    storage: { local: {
      get: async () => { throw new Error("cannot load settings"); },
      set: async () => writes++,
    } },
  } });
  t.after(() => panel.dom.window.close());
  await assert.rejects(panel.initialize(), /cannot load settings/);
  panel.elements.pageContextToggle.click();
  assert.equal(writes, 0);
});
