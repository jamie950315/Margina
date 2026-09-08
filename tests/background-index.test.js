import test from "node:test";
import assert from "node:assert/strict";

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
    await clickListener({ id: 42 });
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
  await assert.rejects(click({ id: 42 }), /側欄沒有確認/);
  assert.deepEqual(badges, ["!"]);
});
