import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 15));

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
  assert.equal(panel.elements.pageContextStatus.tagName, "DIV");
  assert.equal(doc.getElementById("comparedPages").hidden, false);
  doc.querySelector(".compared-page button").click();
  assert.equal(panel.state.comparedPages.length, 0);
  assert.equal(panel.elements.pageContextStatus.hasAttribute("aria-pressed"), false);
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
