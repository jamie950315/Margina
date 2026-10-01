import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const root = new URL("../src/native/welcome/", import.meta.url);
const html = await readFile(new URL("Main.html", root), "utf8");
const script = await readFile(new URL("Script.js", root), "utf8");
const localizations = await readFile(new URL("Localizations.js", root), "utf8");

function page(languages = ["en-US"], nativeLanguages) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  Object.defineProperty(dom.window.navigator, "languages", { value: languages });
  if (nativeLanguages) dom.window.MarginaPreferredLanguages = nativeLanguages;
  dom.window.eval(localizations);
  dom.window.eval(script);
  return dom;
}

test("native welcome explains setup and local account persistence without remote resources", () => {
  const { window } = page();
  const document = window.document;
  assert.equal(document.documentElement.lang, "en");
  assert.equal(document.querySelector("h1").textContent, "Keep ChatGPT beside your reading");
  assert.equal(document.querySelectorAll(".steps li").length, 3);
  assert.match(document.querySelector(".account-note").textContent, /Keychain.*closing Safari.*Sign out.*switch accounts.*expired login/);
  assert.equal(document.querySelector("#extension-status").getAttribute("role"), "status");
  assert.equal(document.querySelectorAll("button").length, 1);
  for (const element of document.querySelectorAll("[src], [href]")) {
    assert.match(element.getAttribute("src") || element.getAttribute("href"), /^\.\.\/(Icon\.png|Style\.css|Localizations\.js|Script\.js)$/);
  }
  assert.match(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /default-src 'none'/);
  assert.doesNotMatch(html + script + localizations, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|window\.close|退出並|Quit and/);
  window.close();
});

test("native welcome show function handles enabled, disabled and unavailable states accessibly", () => {
  const { window } = page();
  const status = window.document.querySelector("#extension-status");
  window.show(true, true);
  assert.equal(status.dataset.state, "on");
  assert.match(status.textContent, /enabled/);
  window.show(false, false);
  assert.equal(status.dataset.state, "off");
  assert.match(status.textContent, /Preferences/);
  assert.match(window.document.querySelector("button").textContent, /Preferences/);
  window.show(undefined, true);
  assert.equal(status.dataset.state, "unknown");
  assert.match(status.textContent, /status is unavailable/);
  window.close();
});

test("native welcome only opens existing native settings action and reports unavailable bridge", () => {
  const { window } = page();
  const actions = [];
  window.webkit = { messageHandlers: { controller: { postMessage: value => actions.push(value) } } };
  window.document.querySelector("button").click();
  assert.deepEqual(actions, ["open-preferences"]);
  delete window.webkit;
  assert.doesNotThrow(() => window.document.querySelector("button").click());
  assert.equal(window.document.querySelector("#extension-status").dataset.state, "error");
  assert.match(window.document.querySelector("#extension-status").textContent, /Safari’s extension settings/);
  window.close();
});

test("native welcome resolves region and script variants and falls back to English", () => {
  const { window } = page();
  const resolve = window.MarginaWelcomeLocalization.resolveLanguage;
  for (const [input, expected] of [
    ["zh-TW", "zh-Hant"], ["zh-HK", "zh-Hant"], ["zh-MO", "zh-Hant"],
    ["zh-CN", "zh-Hans"], ["zh-SG", "zh-Hans"], ["zh", "zh-Hans"],
    ["zh-Hans-TW", "zh-Hans"], ["zh-Hant-CN", "zh-Hant"],
    ["zh_Latn_TW", "en"], ["en-GB", "en"], ["ja-JP", "ja"], ["fr-FR", "en"],
  ]) assert.equal(resolve([input]), expected, input);
  assert.equal(resolve(["fr-FR", "ja-JP"]), "ja");
  assert.equal(resolve([]), "en");
  window.close();
  const native = page(["en-US"], ["ja"]);
  assert.equal(native.window.document.documentElement.lang, "ja", "native system language wins over WebKit's default");
  native.window.close();
});

test("native welcome catalogs cover every message and placeholder in all languages", () => {
  const { window } = page();
  const catalogs = window.MarginaWelcomeLocalization.catalogs;
  const keys = Object.keys(catalogs.en).sort();
  for (const [language, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), keys, language);
    for (const key of keys) {
      assert.ok(catalog[key].trim().length > 0, `${language}.${key}`);
      assert.deepEqual(catalog[key].match(/\{\w+\}/g), catalogs.en[key].match(/\{\w+\}/g), `${language}.${key}`);
    }
  }
  window.close();
});

test("native welcome renders complete setup, status and accessible labels in every language", () => {
  for (const language of ["en", "zh-Hant", "zh-Hans", "ja"]) {
    const { window } = page([language]);
    const document = window.document;
    const l10n = window.MarginaWelcomeLocalization;
    assert.equal(document.documentElement.lang, language);
    assert.equal(document.querySelector("h1").textContent, l10n.catalogs[language].heading);
    assert.equal(document.querySelector(".steps").getAttribute("aria-label"), l10n.catalogs[language].stepsLabel);
    for (const enabled of [true, false, undefined]) {
      window.show(enabled, true);
      assert.ok(!document.querySelector("main").textContent.includes("{settings}"));
      assert.equal(document.querySelector("#extension-status .status-text").textContent,
        l10n.text(enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown", { settings: l10n.text("settings") }));
    }
    document.querySelector("button").click();
    assert.equal(document.querySelector("#extension-status .status-text").textContent, l10n.text("bridgeError"));
    window.close();
  }
});
