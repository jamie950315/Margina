import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";

const turn = text => [{ role: "user", content: text }, { role: "assistant", content: `Answer ${text}` }];
function browserFixture(initial = {}) {
  const data = structuredClone(initial);
  const listeners = new Set();
  const api = {
    runtime: { id: "fixture", getURL: path => `https://extension.test/${path}` },
    permissions: { contains: async () => true },
    storage: { onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      local: { get: async key => structuredClone({ [key]: data[key] }), set: async update => {
        const changes = Object.fromEntries(Object.entries(update).map(([key, value]) => [key, { newValue: value }]));
        Object.assign(data, structuredClone(update));
        for (const fn of listeners) fn(changes, "local");
      } } },
  };
  api.runtime.sendMessage = message => handleStorageMessage(message,
    { id: api.runtime.id, url: api.runtime.getURL("panel.html") }, api);
  return { api, data };
}
async function openPanel(t, fixture, initial = "A") {
  const panel = await panelHarness({ demo: false, browser: fixture.api });
  panel.dom.window.TextDecoder = TextDecoder;
  t.after(() => panel.dom.window.close());
  let page = initial, revision = 0;
  panel.connectBridge(() => ({ ok: true, pageKey: `page-${page}`,
    page: { url: `https://example.com/${page}`, text: `Page ${page}`, identity: `document-${page}` },
    selection: "", contextRevision: revision }));
  await panel.initialize();
  return { panel, navigate: async next => { page = next; revision++; await panel.refreshContext(); } };
}

test("A/B/C each restore their own chat on navigation and a fresh sidebar ignores the global last chat", async t => {
  const fixture = browserFixture();
  const { panel, navigate } = await openPanel(t, fixture);
  panel.state.history = turn("A"); await panel.saveActiveConversation();
  const a = panel.state.activeConversationId;
  await navigate("B");
  assert.equal(panel.state.history.length, 0);
  panel.state.history = turn("B"); await panel.saveActiveConversation();
  const b = panel.state.activeConversationId;
  await navigate("C"); assert.equal(panel.state.history.length, 0);
  panel.state.history = turn("C"); await panel.saveActiveConversation();
  await navigate("A");
  assert.equal(panel.state.activeConversationId, a);
  assert.equal(panel.state.history[1].content, "Answer A");
  await navigate("B");
  assert.equal(panel.state.activeConversationId, b);
  assert.equal(panel.state.history[1].content, "Answer B");
  const reopened = (await openPanel(t, fixture, "A")).panel;
  assert.equal(reopened.state.history[1].content, "Answer A");
  assert.equal(fixture.data.conversations.conversations.length, 3);
});

test("navigation during an API request stops it without putting its answer in the new page", async t => {
  const fixture = browserFixture();
  const { panel } = await openPanel(t, fixture);
  panel.state.history = turn("A"); await panel.saveActiveConversation();
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  panel.dom.window.fetch = (_url, options) => {
    requested();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  };
  panel.elements.promptInput.value = "Question A";
  const sending = panel.submitPrompt({ preventDefault() {} });
  await started;
  panel.connectBridge(() => ({ ok: true, pageKey: "page-B", page: { url: "https://example.com/B", text: "B" }, selection: "", contextRevision: 2 }));
  panel.handleBridgeMessage({ type: "PAGE_CONTEXT_INVALIDATED", pageChanged: true, contextRevision: 2 });
  await sending; await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.state.pageKey, "page-B");
  assert.equal(panel.state.history.length, 0);
  assert.equal(panel.elements.sendButton.disabled, false);
  assert.equal(fixture.data.conversations.conversations[0].messages[1].content, "Answer A");
});

test("an old page's delayed save does not mark the new page's messages saved or clear its draft", async t => {
  const fixture = browserFixture();
  const { panel, navigate } = await openPanel(t, fixture);
  const save = fixture.api.storage.local.set;
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  fixture.api.storage.local.set = async update => { started(); await new Promise(resolve => { release = resolve; }); await save(update); };
  panel.state.history = turn("A");
  const pending = panel.saveActiveConversation(); await began;
  await navigate("B"); panel.elements.promptInput.value = "Draft B";
  release(); await pending;
  assert.equal(panel.state.savedMessageCount, 0);
  assert.equal(panel.state.history.length, 0);
  assert.equal(panel.elements.promptInput.value, "Draft B");
});

for (const success of [true, false]) {
  test(`${success ? "successful" : "failed"} API sends ${success ? "consume" : "preserve"} selected passages`, async t => {
    const fixture = browserFixture({ settings: { ...DEFAULT_SETTINGS, stream: false } });
    const { panel } = await openPanel(t, fixture);
    const cleared = [];
    panel.connectBridge(message => {
      if (message.type === "CLEAR_SELECTION") { cleared.push(message); return { ok: true }; }
      return { ok: true, pageKey: "page-A", page: { url: "https://example.com/A", text: "A context", identity: "document-A" }, selection: "Live passage", contextRevision: 0 };
    });
    await panel.refreshContext();
    panel.state.retainedSelections = ["Retained passage"];
    let body;
    panel.dom.window.fetch = async (_url, options) => {
      body = options.body;
      return success ? new Response(JSON.stringify({ choices: [{ message: { content: "Synthetic answer" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } })
        : new Response("Synthetic failure", { status: 503 });
    };
    panel.elements.promptInput.value = "Explain";
    await panel.submitPrompt({ preventDefault() {} });
    assert.match(body, /Live passage/);
    assert.match(body, /Retained passage/);
    assert.doesNotMatch(body, /page-A|document-A|pageKey|pageSelections/);
    if (success) {
      assert.equal(panel.elements.selectionCard.hidden, true);
      assert.equal(panel.state.retainedSelections.length, 0);
      assert.equal(cleared.length, 1);
      assert.equal(cleared[0].identity, "document-A");
      await panel.refreshContext();
      assert.equal(panel.elements.selectionCard.hidden, true, "the sent live selection is not restored by another context read");
    } else {
      assert.equal(panel.state.selection, "Live passage");
      assert.equal(panel.state.retainedSelections[0], "Retained passage");
      assert.equal(cleared.length, 0);
      assert.equal(panel.elements.promptInput.value, "Explain");
    }
  });
}

test("a new chat applies only to its page and stays empty after reopening", async t => {
  const fixture = browserFixture();
  const { panel, navigate } = await openPanel(t, fixture);
  panel.state.history = turn("A"); await panel.saveActiveConversation();
  await navigate("B"); panel.state.history = turn("B"); await panel.saveActiveConversation();
  await panel.newConversation();
  assert.equal((await openPanel(t, fixture, "B")).panel.state.history.length, 0);
  await navigate("A"); assert.equal(panel.state.history[1].content, "Answer A");
  assert.equal(fixture.data.conversations.conversations.length, 2);
});

test("legacy unbound history remains available without automatically entering a new page's request", async t => {
  const legacy = { id: "legacy", title: "Legacy", updatedAt: 1, messages: turn("Legacy") };
  const fixture = browserFixture({ conversations: { activeConversationId: "legacy", conversations: [legacy] } });
  const { panel } = await openPanel(t, fixture);
  assert.equal(panel.state.history.length, 0);
  assert.equal(panel.state.conversations[0].id, "legacy");
  panel.elements.historyButton.click();
  assert.match(panel.elements.historyList.textContent, /Legacy/);
});

test("a late context response cannot switch back to the page that was left", async t => {
  const fixture = browserFixture();
  const { panel } = await openPanel(t, fixture);
  let finishOld;
  panel.connectBridge(message => message.type === "REQUEST_CONTEXT"
    ? new Promise(resolve => { finishOld = resolve; }) : { ok: true });
  const oldRead = panel.refreshContext();
  await new Promise(resolve => setImmediate(resolve));
  panel.connectBridge(() => ({ ok: true, pageKey: "page-B", page: { url: "https://example.com/B", text: "B" }, selection: "", contextRevision: 2 }));
  await panel.refreshContext();
  finishOld({ ok: true, pageKey: "page-A", page: { url: "https://example.com/A", text: "A" }, selection: "", contextRevision: 1 });
  await oldRead;
  assert.equal(panel.state.pageKey, "page-B");
  assert.equal(panel.state.page.url, "https://example.com/B");
});
