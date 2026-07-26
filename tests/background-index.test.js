import test from "node:test";
import assert from "node:assert/strict";

test("toolbar click ensures the content script exists before toggling once", async () => {
  const calls = [];
  let clickListener;
  const previousBrowser = globalThis.browser;
  const hadBrowser = Object.hasOwn(globalThis, "browser");

  globalThis.browser = {
    action: {
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

  assert.deepEqual(calls, [
    [
      "executeScript",
      {
        target: { tabId: 42 },
        files: ["content-script.js"],
      },
    ],
    [
      "sendMessage",
      {
        tabId: 42,
        message: { type: "TOGGLE_SAFAI_PANEL" },
      },
    ],
  ]);
});
