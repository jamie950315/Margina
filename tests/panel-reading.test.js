import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test("website selection menu settings save immediately, survive reopening and can be restored", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.page.url = "https://chatgpt.com/c/test";
  const doc = panel.dom.window.document;
  doc.getElementById("selectionMenuButton").click();
  assert.match(doc.getElementById("readingContent").textContent, /chatgpt.com/);
  doc.getElementById("disableSelectionSite").click(); await tick();
  assert.equal(panel.state.settings.selectionToolsDisabledSites, "chatgpt.com");
  assert.equal(panel.state.settings.selectionTools, true);
  doc.getElementById("closeReadingButton").click();
  await panel.openSettings();
  doc.getElementById("selectionSettingsButton").click();
  assert.equal(panel.elements.settingsSheet.classList.contains("is-open"), false);
  assert.equal(doc.getElementById("disableSelectionSite").checked, true);
  doc.querySelector('[aria-label="恢復 chatgpt.com 的反白文字選單"]').click(); await tick();
  assert.equal(panel.state.settings.selectionToolsDisabledSites, "");
  assert.equal(doc.getElementById("disableSelectionSite").checked, false);
  assert.equal(panel.state.history.length, 0);
});

test("a failed website preference write keeps the saved exception and reports the error", async t => {
  const panel = await panelHarness({ demo: false, browser: {
    runtime: { id: "synthetic", sendMessage: async () => ({ ok: false, error: "Synthetic write failure" }) },
    storage: { onChanged: { addListener() {}, removeListener() {} }, local: { get: async () => ({}) } },
  } });
  t.after(() => panel.dom.window.close());
  panel.connectBridge(() => ({ ok: true, page: { title: "Test", url: "https://chatgpt.com/", text: "Synthetic page" }, selection: "", contextRevision: 0 }));
  await panel.initialize();
  panel.state.page = { url: "https://chatgpt.com/" };
  const doc = panel.dom.window.document;
  doc.getElementById("selectionMenuButton").click();
  doc.getElementById("disableSelectionSite").click(); await tick();
  assert.equal(panel.state.settings.selectionToolsDisabledSites, "");
  assert.equal(doc.getElementById("disableSelectionSite").checked, false);
  assert.match(panel.elements.toast.textContent, /Synthetic write failure/);
});

test("a disconnected Safari reading request times out instead of leaving a permanent spinner", async t => {
  const panel = await panelHarness({ demo: false, browser: { runtime: { sendMessage: () => new Promise(() => {}) } } });
  t.after(() => panel.dom.window.close());
  const original = panel.dom.window.setTimeout.bind(panel.dom.window);
  panel.dom.window.setTimeout = (callback, delay) => original(callback, delay === 15000 ? 5 : delay);
  await assert.rejects(panel.readingRequest("LIST_READING_TABS"), /逾時/);
});

test("custom commands bring text into the draft without sending or losing existing text", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  panel.elements.promptInput.value = "我的問題";
  doc.getElementById("quickPromptsButton").click();
  assert.equal(doc.getElementById("readingSheet").hidden, false);
  doc.querySelector(".command-use").click();
  assert.match(panel.elements.promptInput.value, /我的問題\n\n請用白話/);
  assert.equal(panel.state.history.length, 0);
  assert.equal(doc.activeElement, panel.elements.promptInput);
});

test("comparing attaches only selected snapshots and can remove a source", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  doc.getElementById("compareTabsButton").click(); await tick();
  doc.querySelector('.reading-tab input[type="checkbox"]').click();
  [...doc.querySelectorAll("#readingContent button")].find(button => button.textContent === "讀取並附上所選分頁").click();
  await tick();
  assert.equal(panel.state.comparedPages.length, 1);
  assert.equal(panel.state.history.length, 0);
  assert.equal(doc.getElementById("pageHeader"), null);
  assert.equal(doc.getElementById("comparedPages").hidden, false);
  doc.querySelector(".compared-page button").click();
  assert.equal(panel.state.comparedPages.length, 0);
  assert.equal(doc.getElementById("pageHeader"), null);
});

test("closing the picker while it reads discards results and locks the submitted selection", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  doc.getElementById("compareTabsButton").click(); await tick();
  const check = doc.querySelector('.reading-tab input[type="checkbox"]');
  check.click();
  [...doc.querySelectorAll("#readingContent button")].find(button => button.textContent === "讀取並附上所選分頁").click();
  assert.equal(check.disabled, true);
  doc.getElementById("closeReadingButton").click();
  await tick();
  assert.equal(panel.state.comparedPages.length, 0);
});

test("quick prompt edits use the existing saved settings writer", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  doc.getElementById("quickPromptsButton").click();
  doc.querySelector('#readingContent input:not([type="checkbox"])').value = "測試指令";
  doc.querySelector("#readingContent textarea").value = "請列出三個例子。";
  [...doc.querySelectorAll("#readingContent button")].find(button => button.textContent === "加入／更新指令").click();
  [...doc.querySelectorAll("#readingContent button")].find(button => button.textContent === "儲存指令").click(); await tick();
  assert.match(panel.state.settings.quickPrompts, /測試指令/);
  assert.equal(panel.state.history.length, 0);
});

test("comparison payload excludes unselected current page and remembered selection", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.page = { title: "Unselected", url: "https://private.example/", text: "not selected" };
  panel.state.selection = "old selection";
  panel.state.comparedPages = [{ tabId: 1, title: "Selected", url: "https://example.com/", text: "Selected source" }];
  const payload = panel.buildCurrentPayload("Compare");
  assert.equal(payload.current_page, undefined);
  assert.equal(payload.selected_text, undefined);
  assert.equal(payload.comparison_pages.length, 1);
  assert.equal(payload.comparison_pages[0].sources[0].text, "Selected source");
});

test("citations only create locator buttons for supplied IDs and never execute model HTML", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  const message = { rawText: "Answer [P1] [P999] <script>bad()</script>", bubble: doc.createElement("div") };
  panel.appendCitations(message, [{ id: "P1", quote: "source", url: "https://example.com", title: "source" }]);
  assert.equal(message.bubble.querySelectorAll("button").length, 1);
  assert.equal(message.bubble.querySelector("button").textContent, "[P1] 原文");
  assert.equal(message.bubble.querySelector("script"), null);
});

test("quick ask pins only the selected quote and does not auto-submit", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.comparedPages = [{ tabId: 1, title: "Old comparison", url: "https://example.com/", text: "Old" }];
  panel.handleBridgeMessage({ type: "QUICK_ASK", selection: "Chosen text", prompt: "Explain" });
  await panel.refreshContext();
  assert.equal(panel.state.selection, "Chosen text");
  assert.equal(panel.state.comparedPages.length, 0);
  assert.equal(panel.buildCurrentPayload("Explain").selected_passages[0].text, "Chosen text");
  assert.equal(panel.elements.promptInput.value, "Explain");
  assert.equal(panel.state.history.length, 0);
});
