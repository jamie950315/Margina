import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { resolveLanguage, setLanguage, getLanguage, t, createDocumentLocalizer, messages } from "../src/i18n/index.js";
import { mergeSettings } from "../src/core/settings.js";

test("language resolution respects scripts, regions, preference order and unsupported languages", () => {
  for (const [languages, expected] of [
    [["zh-TW"], "zh-Hant"], [["zh-HK"], "zh-Hant"], [["zh-MO"], "zh-Hant"],
    [["zh-CN"], "zh-Hans"], [["zh-SG"], "zh-Hans"], [["zh"], "zh-Hans"],
    [["zh-Hant-CN"], "zh-Hant"], [["zh-Hans-TW"], "zh-Hans"],
    [["zh-Latn-TW"], "en"],
    [["ja-JP", "en-US"], "ja"], [["fr-FR", "en-GB"], "en"], [["fr-FR", "ja"], "ja"],
    [[], "en"], [["ar"], "en"],
  ]) assert.equal(resolveLanguage("auto", languages), expected);
  assert.equal(resolveLanguage("en", ["ja"]), "en");
  assert.equal(mergeSettings({}).language, "auto");
  for (const language of ["auto", "en", "zh-Hant", "zh-Hans", "ja"]) {
    assert.equal(mergeSettings({ language }).language, language);
  }
  for (const language of ["fr", "zh-TW", "", null, 1]) assert.throws(() => mergeSettings({ language }));
});

test("catalogs cover every supported language and preserve substitution placeholders", () => {
  for (const [source, translations] of Object.entries(messages)) {
    assert.equal(translations.length, 3, source);
    const placeholders = value => [...value.matchAll(/\{\d+\}/gu)].map(match => match[0]).sort();
    for (const translation of translations) {
      assert.ok(typeof translation === "string" && translation.length, source);
      assert.deepEqual(placeholders(translation), placeholders(source), source);
    }
  }
  setLanguage("en");
  assert.equal(t("標註 {0}", [2]), "Annotation 2");
  assert.equal(t("provider-specific error"), "provider-specific error");
  setLanguage("ja");
  assert.equal(t("關閉"), "閉じる");
  assert.equal(getLanguage(), "ja");
  setLanguage("zh-Hant");
});

test("document localization preserves markup and never translates user content or field values", () => {
  const dom = new JSDOM('<html><body><button aria-label="關閉"><svg></svg>關閉</button><textarea>關閉</textarea><p id="answer"></p></body></html>');
  const localize = createDocumentLocalizer(dom.window.document);
  const answer = dom.window.document.querySelector("#answer");
  answer.textContent = "關閉";
  setLanguage("en");
  localize();
  assert.equal(dom.window.document.documentElement.lang, "en");
  assert.equal(dom.window.document.querySelector("button").textContent, "Close");
  assert.ok(dom.window.document.querySelector("button svg"));
  assert.equal(dom.window.document.querySelector("button").getAttribute("aria-label"), "Close");
  assert.equal(dom.window.document.querySelector("textarea").value, "關閉");
  assert.equal(answer.textContent, "關閉");
  setLanguage("ja");
  localize();
  assert.equal(dom.window.document.querySelector("button").textContent, "閉じる");
  setLanguage("zh-Hant");
  localize();
  assert.equal(dom.window.document.querySelector("button").textContent, "關閉");
  dom.window.close();
});
