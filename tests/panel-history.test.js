import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { panelHarness } from "./helpers/panel-harness.js";

test("conversation history is a sidebar region rather than a modal overlay", async () => {
  const html = await readFile(new URL("../src/panel/panel.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const drawer = dom.window.document.getElementById("historyDrawer");
  const title = dom.window.document.getElementById("historyTitle");

  assert.equal(drawer.getAttribute("role"), "region");
  assert.equal(drawer.hasAttribute("aria-modal"), false);
  assert.equal(drawer.getAttribute("aria-labelledby"), "historyTitle");
  assert.equal(title.textContent, "最近的對話");
});

test("history replaces the chat while preserving toolbar navigation and drafts", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.elements.promptInput.value = "尚未送出的問題";
  panel.elements.historyButton.click();
  assert.equal(panel.elements.historyDrawer.hidden, false);
  assert.equal(panel.elements.conversation.hidden, true);
  assert.equal(panel.elements.composerDock.hidden, true);
  assert.equal(panel.elements.topbar.getAttribute("aria-hidden"), null);
  panel.elements.historyButton.click();
  assert.equal(panel.elements.historyDrawer.hidden, true);
  assert.equal(panel.elements.conversation.hidden, false);
  assert.equal(panel.elements.promptInput.value, "尚未送出的問題");
});

test("mode and attachment menus are exclusive, closable and functional", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  await panel.initialize();
  const document = panel.dom.window.document;
  document.getElementById("modelButton").click();
  assert.equal(document.getElementById("modeMenu").hidden, false);
  document.getElementById("attachButton").click();
  assert.equal(document.getElementById("modeMenu").hidden, true);
  assert.equal(document.getElementById("attachMenu").hidden, false);
  document.dispatchEvent(new panel.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(document.getElementById("attachMenu").hidden, true);
  assert.equal(document.activeElement.id, "attachButton");
});

test("history search filters real stored conversations", async (t) => {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  await panel.initialize();
  panel.state.conversations = [{ id: "one", title: "潮汐", updatedAt: 1, messages: [{ role: "user", content: "潮汐" }] }];
  panel.elements.historyButton.click();
  const search = panel.dom.window.document.getElementById("historySearch");
  search.value = "不存在";
  search.dispatchEvent(new panel.dom.window.Event("input"));
  assert.equal(panel.elements.historyList.querySelectorAll("button").length, 0);
  assert.match(panel.elements.historyList.textContent, /沒有符合/);
});
