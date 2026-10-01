import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { setLanguage } from "../src/i18n/index.js";
import { panelToolsMessages } from "../src/i18n/panel-tools-messages.js";
import { createReadingFeatures } from "../src/panel/reading-features.js";
import { createRelayPanel, validateRelayDraft } from "../src/panel/relay-panel.js";
import { sendNativeRelayCommand } from "../src/panel/native-relay-client.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test.afterEach(() => setLanguage("zh-Hant"));

function readingFixture(t, saved = {}) {
  const dom = new JSDOM(`<button id="attachButton"></button><section id="readingSheet" hidden>
    <h2 id="readingTitle"></h2><button id="closeReadingButton"></button><div id="readingContent"></div></section>`, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const settings = { selectionTools: true, selectionToolsDisabledSites: "", quickPrompts: "", ...saved };
  const drafts = [], notices = [], requests = [], attached = [];
  const reading = createReadingFeatures({ document: dom.window.document, settings: () => settings,
    page: () => ({ url: "https://site.example/" }), saveSettings: async patch => Object.assign(settings, patch),
    request: async (type, payload) => {
      requests.push({ type, payload });
      return type === "LIST_READING_TABS" ? { tabs: [{ id: 1, title: "常用指令", url: "https://source.example/" }] } : { pages: [{ tabId: 1, title: "常用指令", text: "Source content" }] };
    },
    attach: pages => attached.push(pages), usePrompt: value => drafts.push(value), notify: value => notices.push(value), canOpen: () => true, setModal() {} });
  return { reading, dom, document: dom.window.document, settings, drafts, notices, requests, attached };
}

test("reading dialogs localize controls while preserving page titles and saved prompts", async t => {
  setLanguage("ja");
  const saved = [{ id: "saved", title: "常用指令", prompt: "白話解釋" }];
  const h = readingFixture(t, { quickPrompts: JSON.stringify(saved) });
  await h.reading.openTabs();
  assert.equal(h.document.getElementById("readingTitle").textContent, "タブを比較");
  assert.equal(h.document.querySelector("strong").textContent, "常用指令");
  assert.equal(h.document.querySelector('input').getAttribute("aria-label"), "常用指令 を比較");
  h.reading.close();
  h.reading.openCommands();
  assert.equal(h.document.getElementById("readingTitle").textContent, "クイックプロンプト");
  assert.equal(h.document.querySelector(".command-use").textContent, "常用指令");
  h.document.querySelector(".command-use").click();
  assert.deepEqual(h.drafts, ["白話解釋"]);
  assert.equal(h.settings.quickPrompts, JSON.stringify(saved));
});

test("default quick prompts resolve the current language every time the dialog opens", t => {
  const h = readingFixture(t);
  for (const [locale, title, prompt] of [
    ["en", "Explain simply", "Explain this passage in simple terms and give one concrete example."],
    ["zh-Hans", "通俗解释", "请用通俗易懂的语言解释这段内容，并举一个具体例子。"],
    ["ja", "わかりやすく説明", "この内容をわかりやすく説明し、具体例を 1 つ挙げてください。"],
    ["zh-Hant", "白話解釋", "請用白話解釋這段內容，並舉一個具體例子。"],
  ]) {
    setLanguage(locale);
    h.reading.openCommands();
    assert.equal(h.document.querySelector(".command-use").textContent, title);
    h.document.querySelector(".command-use").click();
    assert.equal(h.drafts.at(-1), prompt);
    assert.equal(h.settings.quickPrompts, "");
  }
});

test("active default commands change language while an edited prompt becomes user-owned", t => {
  setLanguage("en");
  const h = readingFixture(t);
  h.reading.openCommands();
  const name = h.document.querySelector('#readingContent input:not([type="checkbox"])');
  const prompt = h.document.querySelector("textarea");
  h.document.querySelector(".reading-command-actions button").click();
  name.value = "常用指令"; prompt.value = "白話解釋";
  [...h.document.querySelectorAll("#readingContent button")].find(button => button.textContent === "Add / update prompt").click();
  setLanguage("ja"); h.reading.refreshLanguage();
  assert.deepEqual([...h.document.querySelectorAll(".command-use")].map(button => button.textContent), ["常用指令", "学習ノート", "論点を検討"]);
  assert.ok(h.document.querySelector('[aria-label="学習ノート を上に移動"]'));
  h.document.querySelectorAll(".command-use")[1].click();
  assert.equal(h.drafts.at(-1), "要点、重要な概念、理解度を確認する問題を含む学習ノートにまとめてください。");
});

test("selection preferences localize restore actions without changing hostname storage", async t => {
  setLanguage("en");
  const h = readingFixture(t, { selectionToolsDisabledSites: "site.example" });
  h.reading.openSelectionSettings();
  const restore = h.document.querySelector('[aria-label="Restore the selection menu on site.example"]');
  assert.ok(restore);
  assert.equal(h.document.getElementById("disableSelectionSite").checked, true);
  restore.click(); await tick();
  assert.equal(h.settings.selectionToolsDisabledSites, "");
  assert.equal(h.notices.at(-1), "Selection menu settings saved");
});

test("open reading dialogs refresh owned labels in place after another panel changes language", async t => {
  setLanguage("en");
  const saved = [{ id: "saved", title: "常用指令", prompt: "白話解釋" }];
  const h = readingFixture(t, { quickPrompts: JSON.stringify(saved), selectionToolsDisabledSites: "site.example" });
  await h.reading.openTabs();
  const selected = h.document.querySelector('.reading-tab input');
  selected.click(); selected.focus();
  setLanguage("ja"); h.reading.refreshLanguage();
  assert.equal(h.document.getElementById("readingTitle").textContent, "タブを比較");
  assert.equal(h.document.querySelector('.reading-tab input'), selected);
  assert.equal(selected.checked, true);
  assert.equal(h.document.activeElement, selected);
  assert.equal(selected.getAttribute("aria-label"), "常用指令 を比較");
  assert.equal(h.document.querySelector("strong").textContent, "常用指令");
  assert.equal(h.requests.length, 1, "language refresh does not read or list tabs again");
  h.document.querySelector("#readingContent button").click(); await tick();
  assert.deepEqual(h.requests[1], { type: "READ_READING_TABS", payload: { items: [{ id: 1, url: "https://source.example/" }] } });
  assert.equal(h.attached.length, 1);

  h.reading.openCommands();
  const name = h.document.querySelector('#readingContent input:not([type="checkbox"])');
  const prompt = h.document.querySelector("textarea");
  h.document.querySelector(".reading-command-actions button").click();
  name.value = "白話解釋";
  prompt.value = "常用指令";
  prompt.focus();
  setLanguage("zh-Hans"); h.reading.refreshLanguage();
  assert.equal(h.document.getElementById("readingTitle").textContent, "常用指令");
  assert.equal(h.document.querySelector('#readingContent input:not([type="checkbox"])'), name);
  assert.equal(h.document.querySelector("textarea"), prompt);
  assert.equal(name.value, "白話解釋");
  assert.equal(prompt.value, "常用指令");
  assert.equal(h.document.activeElement, prompt);
  assert.equal(h.document.querySelector(".command-use").textContent, "常用指令");
  [...h.document.querySelectorAll("#readingContent button")].find(button => button.textContent === "添加／更新指令").click();
  setLanguage("en"); h.reading.refreshLanguage();
  assert.equal(h.document.querySelector(".command-use").textContent, "白話解釋", "unsaved custom edits remain exact");
  assert.equal(h.document.querySelector('[aria-label="Remove prompt 白話解釋"]').textContent, "Remove");
  h.document.querySelector(".command-use").click();
  assert.deepEqual(h.drafts, ["常用指令"]);
  assert.equal(h.settings.quickPrompts, JSON.stringify(saved), "language refresh does not save custom edits");

  h.reading.openSelectionSettings();
  const siteToggle = h.document.getElementById("disableSelectionSite");
  const restore = h.document.querySelector('[aria-label="Restore the selection menu on site.example"]');
  setLanguage("ja"); h.reading.refreshLanguage();
  assert.equal(h.document.getElementById("disableSelectionSite"), siteToggle);
  assert.equal(siteToggle.checked, true);
  assert.equal(h.document.querySelector('[aria-label="site.example の選択メニューを有効にする"]'), restore);
  assert.equal(restore.textContent, "有効にする");
  assert.equal(h.document.querySelector(".selection-site-row span").textContent, "site.example");
  assert.equal(h.settings.selectionToolsDisabledSites, "site.example");
});

test("relay validation and transport failures use the selected interface language", async () => {
  setLanguage("en");
  assert.throws(() => validateRelayDraft("", []), /empty or too long/);
  setLanguage("zh-Hans");
  assert.throws(() => validateRelayDraft("text", Array(9).fill({})), /最多附上 8 张图片/);
  setLanguage("ja");
  await assert.rejects(sendNativeRelayCommand({}, "status", "https://source.example/"), /下書きは保持されています/);
});

test("relay status refreshes its language without an account request or clearing errors", async t => {
  setLanguage("en");
  const dom = new JSDOM(`<section><p data-relay-status></p><iframe></iframe>
    <button data-relay-action="login"></button><button data-relay-action="logout"></button>
    <button data-relay-action="switch"></button><button data-relay-action="reconnect"></button></section>`, { pretendToBeVisual: true });
  let calls = 0;
  const root = dom.window.document.querySelector("section");
  const controller = createRelayPanel({ root, pollMs: 60_000, sendCommand: async () => { calls++; throw new Error("Synthetic native failure"); } });
  t.after(() => { controller.destroy(); dom.window.close(); });
  controller.setActive(true); await tick();
  const status = root.querySelector("[data-relay-status]");
  assert.match(status.textContent, /Reconnect later/);
  assert.equal(status.dataset.error, "true");
  setLanguage("ja"); controller.refreshLanguage();
  assert.match(status.textContent, /後でもう一度接続/);
  assert.equal(status.dataset.error, "true");
  assert.equal(calls, 1);
});

test("auxiliary message translations preserve all numbered placeholders", () => {
  for (const [source, translations] of Object.entries(panelToolsMessages)) {
    const expected = source.match(/\{\d+\}/gu) ?? [];
    assert.equal(translations.length, 3, source);
    for (const translation of translations) {
      assert.ok(translation.trim(), source);
      assert.deepEqual((translation.match(/\{\d+\}/gu) ?? []).sort(), [...expected].sort(), source);
    }
  }
});
