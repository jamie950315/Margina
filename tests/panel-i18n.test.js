import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { panelHarness } from "./helpers/panel-harness.js";
import { messages } from "../src/i18n/index.js";

test("panel follows system language and saves manual changes without changing drafts or citations", async t => {
  const panel = await panelHarness({ languages: ["fr-FR", "en-US"] });
  t.after(() => panel.dom.window.close());
  await panel.initialize();
  const doc = panel.dom.window.document;
  assert.equal(doc.documentElement.lang, "en");
  assert.equal(doc.querySelector(".empty-state h2").textContent, "Understand this page together");
  assert.equal(doc.getElementById("settingsButton").getAttribute("aria-label"), "Open settings");
  panel.elements.promptInput.value = "關閉 — this is my draft";
  panel.state.retainedSelections = ["My original annotation"];
  const answer = panel.addMessage("assistant", "Original answer [P0]");
  const answerText = answer.content.textContent;
  panel.appendCitations(answer, [{ id: "P0", quote: "Original source", title: "Source", url: panel.state.page.url }]);
  const citation = doc.querySelector(".citation-button");
  const conversationId = panel.state.activeConversationId;
  const provider = { baseUrl: panel.state.settings.baseUrl, apiKey: panel.state.settings.apiKey, model: panel.state.settings.model };
  panel.openSettings();
  panel.elements.languageInput.value = "ja";
  await panel.saveSettings({ preventDefault() {} });
  assert.equal(doc.documentElement.lang, "ja");
  assert.equal(panel.state.settings.language, "ja");
  assert.equal(panel.elements.promptInput.value, "關閉 — this is my draft");
  assert.equal(panel.state.retainedSelections[0], "My original annotation");
  assert.equal(panel.state.activeConversationId, conversationId);
  assert.equal(answer.content.textContent, answerText);
  assert.equal(doc.querySelector(".citation-button"), citation);
  assert.equal(citation.textContent, "[P0] 原文");
  assert.deepEqual({ baseUrl: panel.state.settings.baseUrl, apiKey: panel.state.settings.apiKey, model: panel.state.settings.model }, provider);
  assert.equal(panel.elements.toast.textContent, "設定を保存しました。");
  panel.openSettings();
  assert.equal(panel.elements.languageInput.value, "ja");
  panel.closeSettings();
  panel.applyStoredSettings({ ...panel.state.settings, language: "zh-Hans" });
  assert.equal(doc.documentElement.lang, "zh-Hans");
  assert.equal(doc.querySelector(".empty-state h2").textContent, "一起读懂这个页面");
  assert.equal(panel.elements.promptInput.value, "關閉 — this is my draft");
  assert.equal(doc.querySelector(".citation-button"), citation);
});

test("static panel interface has catalog coverage without translating language autonyms", async () => {
  const html = await readFile(new URL("../src/panel/panel.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const walker = doc.createTreeWalker(doc.body, 4);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest("option[lang],script,style")) continue;
    const source = node.textContent.trim();
    if (/[\p{Script=Han}]/u.test(source)) assert.ok(Object.hasOwn(messages, source), source);
  }
  for (const element of doc.querySelectorAll("*")) {
    for (const name of ["aria-label", "title", "placeholder", "alt", "data-prompt"]) {
      const source = element.getAttribute(name);
      if (source && /[\p{Script=Han}]/u.test(source)) assert.ok(Object.hasOwn(messages, source), source);
    }
  }
  dom.window.close();
});
