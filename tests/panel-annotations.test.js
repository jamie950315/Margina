import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test("page context is always attached even when legacy settings disabled it, with no toggle", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.page = { title: "Context", url: "https://example.com/article", text: "Required page context." };
  panel.state.selection = "";
  panel.state.retainedSelections = [];
  panel.state.settings.includePage = false;
  panel.state.settings.includeSelection = false;
  assert.match(JSON.stringify(panel.buildCurrentPayload("Explain").current_page), /Required page context/);
  const doc = panel.dom.window.document;
  assert.equal(doc.getElementById("pageContextToggle"), null);
  assert.equal(doc.querySelector("#pageHeader button, #pageHeader .included"), null);
  assert.equal(doc.getElementById("pageHeader"), null);
});

test("retaining a passage allows a second selection and sends both alongside unmarked page context", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.page = { title: "Context", url: "https://example.com/article", text: "First marked passage. Unmarked essential context. Second marked passage." };
  panel.state.settings.includePage = false;
  panel.handleBridgeMessage({ type: "QUICK_ASK", selection: "First marked passage.", prompt: "Explain both" });
  panel.dom.window.document.getElementById("retainSelectionButton").click(); await tick();
  assert.deepEqual(Array.from(panel.state.retainedSelections), ["First marked passage."]);
  assert.equal(panel.state.selection, "");
  panel.handleBridgeMessage({ type: "SELECTION_CHANGED", selection: "Second marked passage." });
  const payload = panel.buildCurrentPayload("Explain both");
  assert.deepEqual(Array.from(payload.selected_passages, item => item.text), ["First marked passage.", "Second marked passage."]);
  assert.match(JSON.stringify(payload.current_page), /Unmarked essential context/);
  assert.equal(panel.state.history.length, 0);
  panel.dom.window.document.querySelector('[aria-label="移除標註 1"]').click();
  assert.equal(panel.buildCurrentPayload("Explain").selected_passages.length, 1);
});

test("page changes cannot silently combine old annotations with unrelated context", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.retainedSelections = ["Old passage"];
  panel.state.selection = "";
  panel.state.annotationPageUrl = "https://example.com/old";
  panel.state.page = { url: "https://example.com/new", text: "New content" };
  assert.throws(() => panel.buildCurrentPayload("Explain"), /先前的頁面/);
});

test("long-page coverage is visible to both user and model", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.page = { url: "https://example.com/long", text: "x".repeat(32000), truncated: true, originalChars: 50000 };
  panel.handleBridgeMessage({ type: "QUICK_ASK", selection: "marked", prompt: "Explain" });
  const payload = panel.buildCurrentPayload("Explain");
  assert.equal(payload.current_page.truncated, true);
  assert.equal(payload.current_page.original_characters, 50000);
  assert.match(panel.dom.window.document.getElementById("contextCoverage").textContent, /依設定容量/);
});

test("opaque page identity blocks query-only navigation without sending private URLs", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.retainedSelections = ["Old marked text"];
  panel.state.selection = "";
  panel.state.annotationPageUrl = "https://example.com/watch";
  panel.state.annotationPageIdentity = "document-A";
  panel.state.page = { url: "https://example.com/watch", text: "New video", identity: "document-B" };
  assert.throws(() => panel.buildCurrentPayload("Explain"), /換成其他內容/);
});

test("annotations cannot be sent without readable page context", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.selection = "Selected passage";
  panel.state.page = null;
  assert.throws(() => panel.buildCurrentPayload("Explain"), /不會只傳送標註/);
  panel.state.page = { text: "   " };
  assert.throws(() => panel.buildCurrentPayload("Explain"), /不會只傳送標註/);
});

test("ChatGPT does not copy annotation-only handoff or leave the composer locked", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  let copied = false;
  Object.defineProperty(panel.dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { copied = true; } } });
  panel.state.settings.mode = "chatgpt";
  panel.state.page = null;
  panel.state.selection = "Selected passage";
  panel.elements.promptInput.value = "Explain";
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(copied, false);
  assert.equal(panel.elements.sendButton.disabled, false);
  assert.match(panel.elements.toast.textContent, /不會只傳送標註/);
});
