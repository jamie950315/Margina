import test from "node:test";
import assert from "node:assert/strict";

import { handleBackgroundMessage } from "../src/background/handlers.js";

test("handleBackgroundMessage captures only the sender tab window", async () => {
  const calls = [];
  const listeners = new Set();
  const browserApi = {
    tabs: {
      query: async () => [{ id: 17 }],
      captureVisibleTab: async (...args) => {
        calls.push(args);
        return "data:image/png;base64,SHOT";
      },
      onActivated: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };

  const result = await handleBackgroundMessage(
    { type: "CAPTURE_VISIBLE_TAB" },
    { tab: { id: 17, windowId: 9 } },
    browserApi,
  );

  assert.deepEqual(result, { ok: true, dataUrl: "data:image/png;base64,SHOT" });
  assert.deepEqual(calls, [[9, { format: "png" }]]);
  assert.equal(listeners.size, 0);
});

test("handleBackgroundMessage refuses screenshot calls without a sender tab", async () => {
  const result = await handleBackgroundMessage(
    { type: "CAPTURE_VISIBLE_TAB" },
    {},
    { tabs: {} },
  );

  assert.deepEqual(result, { ok: false, error: "找不到目前分頁" });
});

test("handleBackgroundMessage refuses capture when the sender tab is no longer active", async () => {
  let captured = false;
  const browserApi = {
    tabs: {
      query: async () => [{ id: 88 }],
      captureVisibleTab: async () => {
        captured = true;
        return "data:image/png;base64,WRONG";
      },
      onActivated: { addListener() {}, removeListener() {} },
    },
  };

  const result = await handleBackgroundMessage(
    { type: "CAPTURE_VISIBLE_TAB" },
    { tab: { id: 17, windowId: 9 } },
    browserApi,
  );

  assert.deepEqual(result, { ok: false, error: "目前分頁已切換，請重新擷取" });
  assert.equal(captured, false);
});

test("handleBackgroundMessage discards a screenshot if any tab switch occurs during capture", async () => {
  const listeners = new Set();
  const browserApi = {
    tabs: {
      query: async () => [{ id: 17 }],
      captureVisibleTab: async () => {
        for (const listener of listeners) listener({ tabId: 88, windowId: 9 });
        return "data:image/png;base64,WRONG";
      },
      onActivated: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };

  const result = await handleBackgroundMessage(
    { type: "CAPTURE_VISIBLE_TAB" },
    { tab: { id: 17, windowId: 9 } },
    browserApi,
  );

  assert.deepEqual(result, { ok: false, error: "擷取期間分頁已切換，截圖已丟棄" });
  assert.equal(listeners.size, 0);
});

test("handleBackgroundMessage opens ChatGPT as a first-party tab", async () => {
  let createOptions;
  const browserApi = {
    tabs: {
      create: async (options) => {
        createOptions = options;
        return { id: 22 };
      },
    },
  };

  const result = await handleBackgroundMessage(
    { type: "OPEN_CHATGPT" },
    { tab: { id: 17 } },
    browserApi,
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(createOptions, { url: "https://chatgpt.com/", active: true });
});
