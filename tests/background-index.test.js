import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import vm from "node:vm";

test("Safari uses a nonpersistent extension event page and registers bundled listeners synchronously", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3, "MV3 event pages are nonpersistent by default");
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

test("toolbar click ensures the content script exists before toggling once", async () => {
  const calls = [];
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
        return [{ frameId: 0, result: options.func ? { ok: true, visible: true } : null }];
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

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["executeScript", { target: { tabId: 42 }, files: ["content-script.js"] }]);
  assert.equal(calls[1][0], "executeScript");
  assert.deepEqual(calls[1][1].target, { tabId: 42 });
  assert.equal(typeof calls[1][1].func, "function");
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
