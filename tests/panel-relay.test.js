import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createRelayPanel, validateRelayDraft } from "../src/panel/relay-panel.js";
import { panelHarness } from "./helpers/panel-harness.js";

const providerURL = `http://safai-provider-01234567-89ab-cdef-0123-456789abcdef.localhost:48123/?__safai_key=${"a".repeat(64)}`;
const signedIn = { ok: true, phase: "signedIn", revision: 4, message: "已登入", providerURL };
const signedOut = { ok: true, phase: "signedOut", revision: 5, message: "已登出" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness(t, { response = signedIn, timeoutMs = 1000, commandTimeoutMs = 1000 } = {}) {
  const html = await readFile(new URL("../src/panel/panel.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://extension.test/panel.html", pretendToBeVisual: true });
  const root = dom.window.document.getElementById("chatgptBanner");
  const calls = [], channels = [], frames = [], drafts = [];
  let value = response, draftResult = { ok: true };
  const controller = createRelayPanel({ root, timeoutMs, commandTimeoutMs, pollMs: 60_000, sendCommand: async action => { calls.push(action); return typeof value === "function" ? value(action) : value; }, createChannel: () => {
    const channel = { port1: { start() {}, close() {}, postMessage(message) {
      drafts.push(message);
      if (draftResult) queueMicrotask(() => channel.port1.onmessage({ data: { type: "RESULT", id: message.id, ...draftResult } }));
    } }, port2: {} };
    channels.push(channel); return channel;
  } });
  t.after(() => { controller.destroy(); dom.window.close(); });
  const frame = root.querySelector("iframe");
  function loaded(acknowledge = true) {
    frame.contentWindow.postMessage = (...args) => frames.push(args);
    frame.dispatchEvent(new dom.window.Event("load"));
    if (acknowledge) channels.at(-1)?.port1.onmessage({ data: { type: "READY" } });
  }
  return { controller, root, frame, calls, drafts, frames, loaded, channels, dom,
    setResponse(next) { value = next; }, setDraftResult(next) { draftResult = next; } };
}

test("ChatGPT stays disconnected until active and signed in; restoring does not load a frame", async t => {
  const h = await harness(t, { response: { ok: true, phase: "restoring", revision: 1, message: "確認登入中" } });
  assert.equal(h.calls.length, 0); assert.equal(h.frame.hasAttribute("src"), false);
  h.controller.setActive(true); await tick();
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.equal(h.root.querySelector('[data-relay-action="login"]').disabled, true);
  h.setResponse(signedIn); await h.controller.refresh();
  assert.equal(h.frame.src, providerURL);
  assert.equal(h.frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.ok(!h.frame.getAttribute("sandbox").includes("allow-top-navigation"));
  h.loaded();
  assert.equal(h.frames[0][0].type, "SAFAI_RELAY_CONNECT");
  assert.equal(h.frames[0][0].key, "a".repeat(64));
  assert.equal(h.frames[0][1], new URL(providerURL).origin);
  assert.equal(h.frames[0][2][0], h.channels[0].port2);
});

test("draft handshake carries exact structured text/images with no automatic send or clipboard step", async t => {
  const h = await harness(t);
  h.controller.setActive(true); await tick(); h.loaded();
  const image = { dataUrl: "data:image/png;base64,AQID", name: "untrusted filename" };
  await h.controller.prepareDraft("Question and annotated context", [image]);
  assert.deepEqual(h.drafts, [{ type: "PREPARE_DRAFT", id: "draft-1", text: "Question and annotated context", attachments: [{ dataUrl: image.dataUrl, name: "Margina-1.png" }] }]);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /確認草稿與圖片上傳完成後再送出/);
  assert.ok(h.calls.every(action => action === "status"), "native IPC never receives page data");
});

test("account rotation during pre-draft status refresh requires a second explicit attachment gesture", async t => {
  const h = await harness(t); h.controller.setActive(true); await tick(); h.loaded();
  const nextURL = providerURL.replace("a".repeat(64), "b".repeat(64));
  h.setResponse({ ...signedIn, revision: 10, providerURL: nextURL });
  await assert.rejects(h.controller.prepareDraft("Private page for the prior account", []), /請確認目前帳號後再附加/);
  assert.equal(h.drafts.length, 0);
  assert.equal(h.frame.src, nextURL, "the UI may show the changed session without transferring page content");
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /草稿仍保留/);
  h.loaded();
  await h.controller.prepareDraft("Explicitly confirmed retry", []);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].text, "Explicitly confirmed retry");
});

test("provider draft refusal is surfaced and not retried; malformed or excess images never partially transfer", async t => {
  const h = await harness(t); h.controller.setActive(true); await tick(); h.loaded();
  h.setDraftResult({ ok: false, error: "ChatGPT 已有未送出的草稿；請先處理。" });
  await assert.rejects(h.controller.prepareDraft("Keep this", []), /已有未送出的草稿/);
  assert.equal(h.drafts.length, 1);
  await h.controller.refresh();
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /已有未送出的草稿/);
  await assert.rejects(h.controller.prepareDraft("Keep this", [{ dataUrl: "data:image/svg+xml;base64,AQID" }]), /有圖片無法附加/);
  await assert.rejects(h.controller.prepareDraft("Keep this", Array(9).fill({ dataUrl: "data:image/png;base64,AQID" })), /最多附上 8/);
  assert.equal(h.drafts.length, 1);
  assert.throws(() => validateRelayDraft("x".repeat(196609), []), /太長/);
});

test("logout detaches immediately and a stale status cannot reattach an authenticated frame", async t => {
  const h = await harness(t); h.controller.setActive(true); await tick(); h.loaded();
  const old = deferred(), logout = deferred();
  h.setResponse(action => action === "logout" ? logout.promise : old.promise);
  const refreshing = h.controller.refresh();
  h.root.querySelector('[data-relay-action="logout"]').click();
  assert.equal(h.frame.hasAttribute("src"), false);
  logout.resolve(signedOut); await tick();
  old.resolve(signedIn); await refreshing;
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /已登出/);
});

test("activation, focus and explicit refresh share one in-flight status request", async t => {
  const waiting = deferred();
  const h = await harness(t, { response: () => waiting.promise });
  h.controller.setActive(true);
  h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
  h.dom.window.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
  const refresh = h.controller.refresh();
  await tick();
  const pendingCalls = [...h.calls];
  waiting.resolve(signedIn);
  await refresh;
  assert.deepEqual(pendingCalls, ["status"]);
  assert.equal(h.frame.src, providerURL);
  await h.controller.refresh();
  assert.deepEqual(h.calls, ["status", "status"], "a completed check does not cache later account checks");
});

test("concurrent draft gestures are rejected while the first waits for status", async t => {
  const h = await harness(t);
  h.controller.setActive(true); await tick(); h.loaded();
  const waiting = deferred();
  h.setResponse(() => waiting.promise);
  const first = h.controller.prepareDraft("First explicit draft", []);
  const duplicate = h.controller.prepareDraft("Duplicate gesture", []).then(() => null, error => error);
  waiting.resolve(signedIn);
  await first;
  assert.match((await duplicate)?.message ?? "", /等待目前的附加操作/);
  assert.equal(h.drafts.length, 1);
  assert.equal(h.drafts[0].text, "First explicit draft");
  await h.controller.prepareDraft("Next explicit draft", []);
  assert.equal(h.drafts.length, 2, "the guard is released after completion");
});

test("failed logout remains detached and account switch does not reuse the old provider channel", async t => {
  const h = await harness(t); h.controller.setActive(true); await tick(); h.loaded();
  h.setResponse({ ok: false, error: "native failure" });
  h.root.querySelector('[data-relay-action="logout"]').click(); await tick();
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /操作未成功/);
  h.setResponse(signedIn); await h.controller.refresh(); h.loaded();
  h.setResponse({ ok: true, phase: "waitingForUser", revision: 10, message: "請完成登入" });
  h.root.querySelector('[data-relay-action="switch"]').click(); await tick();
  assert.equal(h.calls.at(-1), "switch"); assert.equal(h.frame.hasAttribute("src"), false);
});

test("blocked saved login retries only on explicit reconnect and stays detached while restoring", async t => {
  const h = await harness(t, { response: { ok: true, phase: "blocked", revision: 5, message: "連線暫時未確認；登入仍保留" } });
  h.controller.setActive(true); await tick();
  const reconnect = h.root.querySelector('[data-relay-action="reconnect"]');
  assert.equal(reconnect.hidden, false);
  await h.controller.refresh(); assert.ok(h.calls.every(action => action === "status"));
  h.setResponse({ ok: true, phase: "restoring", revision: 6, message: "重新確認中" });
  reconnect.click(); await tick();
  assert.equal(h.calls.at(-1), "reconnect");
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.equal(h.root.querySelector('[data-relay-action="login"]').disabled, true);
  h.setResponse(signedIn); await h.controller.refresh();
  assert.equal(h.frame.src, providerURL);
});

test("hidden mode pauses checks and new session invalidates an outstanding draft", async t => {
  const h = await harness(t); h.controller.setActive(true); await tick(); h.loaded();
  h.setDraftResult(null);
  const operation = h.controller.prepareDraft("Pending", []);
  const rejected = assert.rejects(operation, /連線已變更/);
  await tick(); h.setResponse(signedOut); await h.controller.refresh(); await rejected;
  h.controller.setActive(false);
  const before = h.calls.length;
  h.dom.window.dispatchEvent(new h.dom.window.Event("focus"));
  await h.controller.refresh(); assert.equal(h.calls.length, before);
});

test("malformed native provider URLs never reach iframe", async t => {
  const h = await harness(t, { response: { ...signedIn, providerURL: "http://evil.test/?__safai_key=x" } });
  h.controller.setActive(true); await tick();
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /無法確認/);
});

test("unacknowledged draft times out with an explicit check-before-retry warning", async t => {
  const h = await harness(t, { timeoutMs: 25 }); h.controller.setActive(true); await tick(); h.loaded();
  h.setDraftResult(null);
  await assert.rejects(h.controller.prepareDraft("Keep my text", []), /避免重複附加/);
  assert.equal(h.drafts.length, 1);
  await h.controller.refresh();
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /Margina 草稿仍保留/);
});

test("handshake failure survives an unchanged login-status heartbeat", async t => {
  const h = await harness(t, { timeoutMs: 20 }); h.controller.setActive(true); await tick(); h.loaded(false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /尚未準備好接收內容/);
  await h.controller.refresh();
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /尚未準備好接收內容/);
  assert.equal(h.root.querySelector('[data-relay-status]').dataset.error, "true");
});

test("a native runtime message that never settles reports timeout without claiming logout", async t => {
  const never = new Promise(() => {});
  const h = await harness(t, { response: () => never, commandTimeoutMs: 20 });
  h.controller.setActive(true);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /正在確認/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /Safari 尚未回覆/);
  assert.equal(h.root.querySelector('[data-relay-action="reconnect"]').disabled, false);
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.deepEqual(h.calls, ["status"]);
});

test("a stuck reconnect unlocks at panel deadline; a late reply cannot attach the expired operation", async t => {
  const h = await harness(t, { commandTimeoutMs: 20 });
  h.controller.setActive(true); await tick(); h.loaded();
  const late = deferred();
  h.setResponse(() => late.promise);
  h.root.querySelector('[data-relay-action="reconnect"]').click();
  assert.equal(h.root.querySelector('[data-relay-action="reconnect"]').disabled, true);
  assert.equal(h.frame.hasAttribute("src"), false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.root.querySelector('[data-relay-action="reconnect"]').disabled, false);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /Safari 尚未回覆/);
  late.resolve(signedIn); await tick();
  assert.equal(h.frame.hasAttribute("src"), false);
  assert.match(h.root.querySelector('[data-relay-status]').textContent, /Safari 尚未回覆/);
  assert.deepEqual(h.calls, ["status", "reconnect"]);
});

test("initial storage failure never binds native relay controls", async t => {
  const native = [];
  const panel = await panelHarness({ demo: false, url: "safari-web-extension://test/panel.html#bridge=test-token", browser: {
    runtime: { id: "test", getURL: path => `safari-web-extension://test/${path}`, sendNativeMessage: (...args) => { native.push(args); }, sendMessage: async () => { throw new Error("unexpected background message"); } },
    storage: { local: { get: async () => { throw new Error("storage unavailable"); } } },
  } }); t.after(() => panel.dom.window.close());
  await assert.rejects(panel.initialize(), /設定|storage|讀取/);
  panel.dom.window.document.querySelector('[data-relay-action="login"]').click();
  assert.equal(native.length, 0);
});

test("initialized Safari panel uses the direct callback-native client, never a background relay message", async t => {
  const native = [], background = [], reads = [];
  const panel = await panelHarness({ demo: false, url: "safari-web-extension://test/panel.html#bridge=test-token", browser: {
    runtime: {
      id: "test", getURL: path => `safari-web-extension://test/${path}`,
      sendNativeMessage: (application, message, callback) => { native.push({ application, message, reads: [...reads] }); queueMicrotask(() => callback(signedOut)); },
      sendMessage: async message => {
        if (message.type === "GET_SETTINGS") { reads.push("settings"); return { ok: true, settings: { mode: "chatgpt" } }; }
        background.push(message); throw new Error("relay must not use background");
      },
    },
    storage: {
      local: { get: async key => { reads.push(key); return key === "settings" ? { settings: { mode: "chatgpt" } } : {}; } },
      onChanged: { addListener() {}, removeListener() {} },
    },
  } }); t.after(() => panel.dom.window.close());
  panel.connectBridge(() => ({ ok: true, page: { title: "Fixture", url: "https://fixture.example/", text: "Synthetic context" }, selection: "", contextRevision: 0 }));
  await panel.initialize(); await tick();
  assert.equal(native.length, 1);
  assert.deepEqual(native[0].reads.sort(), ["conversations", "settings"]);
  assert.equal(native[0].application, "dev.jamie.safai");
  assert.equal(native[0].message.action, "status");
  assert.equal(background.length, 0);
  assert.match(panel.dom.window.document.querySelector('[data-relay-status]').textContent, /已登出/);
});

test("ChatGPT demo preserves source draft without clipboard writes, native login, or fake success", async t => {
  const panel = await panelHarness(); t.after(() => panel.dom.window.close());
  await panel.initialize();
  let copied = false;
  Object.defineProperty(panel.dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => { copied = true; } } });
  await panel.applyMode("chatgpt", { save: false });
  panel.state.settings.includePage = false; panel.state.settings.includeSelection = false;
  panel.elements.promptInput.value = "Keep my question";
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(copied, false);
  assert.equal(panel.elements.promptInput.value, "Keep my question");
  assert.equal(panel.state.history.length, 0);
  assert.equal(panel.elements.sendButton.getAttribute("aria-label"), "附到 ChatGPT");
  assert.match(panel.elements.toast.textContent, /預覽模式/);
});
