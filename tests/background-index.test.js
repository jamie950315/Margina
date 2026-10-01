import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import vm from "node:vm";

test("Safari uses a nonpersistent extension event page and registers bundled listeners synchronously", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3, "MV3 event pages are nonpersistent by default");
  assert.equal(manifest.default_locale, "en");
  for (const locale of ["en", "zh_TW", "zh_CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../src/_locales/${locale}/messages.json`, import.meta.url), "utf8"));
    for (const placeholder of [manifest.description, manifest.action.default_title]) {
      const key = /^__MSG_(.+)__$/u.exec(placeholder)?.[1];
      assert.ok(messages[key]?.message, `${locale} must resolve ${placeholder}`);
    }
  }
  assert.deepEqual(manifest.background, { scripts: ["background.js"] });
  const bundle = await build({ entryPoints: [new URL("../src/background/index.js", import.meta.url).pathname], bundle: true,
    write: false, format: "iife", target: "safari15.4" });
  for (const namespace of ["browser", "chrome"]) {
    const listeners = {};
    const api = { action: { onClicked: { addListener(fn) { listeners.click = fn; } } },
      runtime: { onMessage: { addListener(fn) { listeners.message = fn; } } } };
    const context = vm.createContext({ [namespace]: api });
    vm.runInContext(bundle.outputFiles[0].text, context);
    assert.equal(typeof listeners.click, "function");
    assert.equal(typeof listeners.message, "function");
  }
});

test("toolbar click uses the existing controller without reinjecting the content script", async () => {
  const calls = [];
  let toggles = 0;
  const page = vm.createContext({ __safaiTogglePanel() { toggles += 1; return { ok: true, visible: true }; } });
  let clickListener;
  const previousBrowser = globalThis.browser;
  const hadBrowser = Object.hasOwn(globalThis, "browser");

  globalThis.browser = {
    action: {
      async setTitle() {},
      async setBadgeText() {},
      onClicked: {
        addListener(listener) {
          clickListener = listener;
        },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
    },
    scripting: {
      async executeScript(options) {
        calls.push(["executeScript", options]);
        assert.equal(options.files, undefined, "an initialized page must not reload the bundle");
        return [{ frameId: 0, result: vm.runInContext(`(${options.func.toString()})()`, page) }];
      },
    },
    tabs: {
      async sendMessage(tabId, message) {
        calls.push(["sendMessage", { tabId, message }]);
        return undefined;
      },
    },
  };

  try {
    await import(`../src/background/index.js?test=${Date.now()}`);
    assert.equal(typeof clickListener, "function");
    await clickListener({ id: 42, url: "https://example.com/article" });
  } finally {
    if (hadBrowser) globalThis.browser = previousBrowser;
    else delete globalThis.browser;
  }

  assert.equal(calls.length, 1);
  assert.equal(toggles, 1);
  assert.equal(calls[0][0], "executeScript");
  assert.deepEqual(calls[0][1].target, { tabId: 42 });
  assert.equal(typeof calls[0][1].func, "function");
});

let toolbarHarnessSequence = 0;

async function toolbarHarness(t, executeScript) {
  const previous = globalThis.browser;
  const hadBrowser = Object.hasOwn(globalThis, "browser");
  t.after(() => {
    if (hadBrowser) globalThis.browser = previous;
    else delete globalThis.browser;
  });
  let click;
  const calls = [];
  const badges = [];
  globalThis.browser = {
    action: {
      onClicked: { addListener(listener) { click = listener; } },
      async setBadgeText(value) { badges.push(value.text); },
      async setTitle() {},
    },
    runtime: { onMessage: { addListener() {} } },
    scripting: { async executeScript(options) {
      calls.push(options);
      return executeScript(options);
    } },
  };
  await import(`../src/background/index.js?toolbar-harness=${++toolbarHarnessSequence}`);
  return { click, calls, badges };
}

test("toolbar installs a missing controller before toggling a cold page exactly once", async t => {
  const page = vm.createContext({});
  let toggles = 0;
  const h = await toolbarHarness(t, options => {
    if (options.files) {
      page.__safaiTogglePanel = () => { toggles += 1; return { ok: true, visible: true }; };
      return [{ frameId: 0 }];
    }
    return [{ frameId: 0, result: vm.runInContext(`(${options.func.toString()})()`, page) }];
  });
  await h.click({ id: 42, url: "https://example.com/article" });
  assert.equal(h.calls.length, 3);
  assert.equal(typeof h.calls[0].func, "function");
  assert.deepEqual(h.calls[1], { target: { tabId: 42 }, files: ["content-script.js"] });
  assert.equal(typeof h.calls[2].func, "function");
  assert.equal(toggles, 1);
  assert.deepEqual(h.badges, [""]);
});

test("an existing controller failure does not reinject or toggle again", async t => {
  let toggles = 0;
  const page = vm.createContext({ __safaiTogglePanel() { toggles += 1; throw new Error("controller failed"); } });
  const h = await toolbarHarness(t, options => [{ frameId: 0,
    result: vm.runInContext(`(${options.func.toString()})()`, page) }]);
  await assert.rejects(h.click({ id: 42, url: "https://example.com/article" }), /controller failed/);
  assert.equal(h.calls.length, 1);
  assert.equal(toggles, 1);
  assert.deepEqual(h.badges, ["!"]);
});

test("only an explicit missing controller result allows content injection", async t => {
  let result;
  const h = await toolbarHarness(t, () => [{ frameId: 0, result }]);
  for (result of [null, undefined, { ok: false }, { missing: "true" }]) {
    const callCount = h.calls.length;
    await assert.rejects(h.click({ id: 42, url: "https://example.com/article" }), /側欄沒有確認/);
    assert.equal(h.calls.length, callCount + 1);
    assert.equal(h.badges.at(-1), "!");
  }
});

test("cold-page injection errors stop before a toggle is attempted", async t => {
  const h = await toolbarHarness(t, options => options.files
    ? [{ frameId: 0, error: "injection failed" }]
    : [{ frameId: 0, result: { missing: true } }]);
  await assert.rejects(h.click({ id: 42, url: "https://example.com/article" }), /側欄程式無法載入/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.badges, ["!"]);
});

test("missing toggle confirmation marks the toolbar as failed", async (t) => {
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; });
  let click;
  const badges = [];
  globalThis.browser = {
    action: {
      onClicked: { addListener(listener) { click = listener; } },
      async setBadgeText(value) { badges.push(value.text); },
      async setTitle() {},
    },
    runtime: { onMessage: { addListener() {} } },
    scripting: { async executeScript() { return [{ frameId: 0, result: null }]; } },
  };
  await import(`../src/background/index.js?failure=${Date.now()}`);
  await assert.rejects(click({ id: 42, url: "https://example.com/article" }), /側欄沒有確認/);
  assert.deepEqual(badges, ["!"]);
});

test("the toolbar explains unsupported pages without attempting content injection", async (t) => {
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; });
  let click;
  const badges = [];
  const titles = [];
  globalThis.browser = {
    action: {
      onClicked: { addListener(listener) { click = listener; } },
      async setBadgeText(value) { badges.push(value.text); },
      async setTitle(value) { titles.push(value.title); },
    },
    runtime: { onMessage: { addListener() {} } },
    scripting: { async executeScript() { assert.fail("unsupported pages must not be injected"); } },
  };
  await import(`../src/background/index.js?unsupported=${Date.now()}`);
  for (const url of [undefined, "", "about:blank", "safari://startpage", "file:///tmp/example.html", "safari-web-extension://fixture/panel.html", "not a URL"]) {
    await click({ id: 42, url });
    assert.equal(badges.at(-1), "!");
    assert.match(titles.at(-1), /HTTP\/HTTPS/);
    assert.doesNotMatch(titles.at(-1), /重新載入/);
  }
});

test("toolbar titles follow Safari's UI language without changing shared runtime language", async t => {
  const previous = globalThis.browser;
  t.after(() => { globalThis.browser = previous; });
  const { setLanguage, getLanguage } = await import("../src/i18n/index.js");
  setLanguage("zh-Hant");
  for (const [language, expected] of [["en-US", "Open Margina"], ["zh-TW", "開啟 Margina"],
    ["zh-CN", "打开 Margina"], ["ja-JP", "Margina を開く"]]) {
    let click;
    const titles = [];
    globalThis.browser = {
      i18n: { getUILanguage: () => language },
      action: {
        onClicked: { addListener(listener) { click = listener; } },
        async setBadgeText() {},
        async setTitle(value) { titles.push(value.title); },
      },
      runtime: { onMessage: { addListener() {} } },
      scripting: { async executeScript() { return [{ frameId: 0, result: { ok: true } }]; } },
    };
    await import(`../src/background/index.js?language=${language}`);
    await click({ id: 42, url: "https://example.com/article" });
    assert.equal(titles.at(-1), expected);
    assert.equal(getLanguage(), "zh-Hant");
  }
});
