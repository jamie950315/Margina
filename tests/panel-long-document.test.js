import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { createDocumentIndex } from "../src/core/long-document.js";
import { selectCenteredContext } from "../src/core/context-budget.js";
import { estimateRequestTokens, requestInputBudget } from "../src/core/request-budget.js";
import http from "node:http";
import { once } from "node:events";

async function setup(t, contextWindowTokens = 262144) {
  const text = "背景資料。".repeat(12000) + "尾端答案：特殊代碼是北極星。";
  const index = createDocumentIndex({ title: "Long", url: "https://example.com/long", text });
  const data = { settings: { ...DEFAULT_SETTINGS, stream: false, contextWindowTokens } };
  const api = {
    runtime: { id: "test", getURL: path => `https://extension.test/${path}` },
    permissions: { contains: async () => true },
    storage: { onChanged: { addListener() {}, removeListener() {} }, local: { get: async key => ({ [key]: data[key] }), set: async patch => Object.assign(data, patch) } },
  };
  api.runtime.sendMessage = message => handleStorageMessage(message, { id: "test", url: api.runtime.getURL("panel.html") }, api);
  const panel = await panelHarness({ demo: false, browser: api }); t.after(() => panel.dom.window.close());
  panel.dom.window.TextDecoder = TextDecoder;
  const calls = [], bridgeCalls = [];
  let selection = "", valid = true;
  panel.dom.window.fetch = async (_, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    return new Response(JSON.stringify({ choices: [{ message: { content: "特殊代碼是北極星。" }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
  };
  panel.connectBridge(message => {
    bridgeCalls.push(message);
    if (message.type === "REQUEST_CONTEXT") return { ok: true, page: { title: index.title, url: index.url, text: text.slice(0, 32000), truncated: true, originalChars: text.length, identity: "doc" }, selection, contextRevision: 0 };
    if (message.type === "PREPARE_LONG_CONTEXT") return { ok: true, plan: {
      snapshotId: "snapshot", title: index.title, url: index.url, totalChars: index.totalChars, batchCount: 6,
      context: selectCenteredContext(index, { ...message, anchorOffset: text.length - 20 }),
    } };
    if (message.type === "VALIDATE_LONG_CONTEXT" && !valid) return { ok: false, error: "snapshot changed" };
    return { ok: true };
  });
  await panel.initialize();
  panel.elements.promptInput.value = "特殊代碼是什麼？";
  return { panel, api, index, calls, text, data, bridgeCalls, setSelection: x => { selection = x; }, invalidate: () => { valid = false; } };
}

test("full readable text fits in one API call without summaries or reading modes", async t => {
  const { panel, calls, text, bridgeCalls } = await setup(t);
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(calls.length, 1, panel.elements.toast.textContent);
  const payload = JSON.parse(calls[0].messages.at(-1).content.split("\n\n").slice(1).join("\n\n"));
  assert.equal(payload.current_page.sources.map(source => source.text).join(""), text);
  assert.equal(payload.current_page.coverage.complete, true);
  assert.equal(payload.current_page.coverage.strategy, "centered");
  assert.equal(bridgeCalls.filter(x => x.type === "READ_LONG_BATCH").length, 0);
  assert.equal(bridgeCalls.filter(x => x.type === "RELEASE_LONG_CONTEXT").length, 1);
  assert.equal(panel.dom.window.document.getElementById("longMode"), null);
});

test("small context window crops around current selection and final serialized request fits", async t => {
  const { panel, calls, bridgeCalls } = await setup(t, 8192);
  panel.state.settings.includeSelection = true;
  const selected = "尾端答案：特殊代碼是北極星。";
  // Quick selection remains the focus when a context refresh clears the DOM range.
  panel.handleBridgeMessage({ type: "QUICK_ASK", selection: selected, prompt: "特殊代碼是什麼？" });
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(calls.length, 1, panel.elements.toast.textContent);
  assert.match(calls[0].messages.at(-1).content, /北極星/);
  assert.ok(estimateRequestTokens(calls[0].messages) <= requestInputBudget({ contextWindowTokens: 8192 }));
  assert.match(calls[0].messages.at(-1).content, /"complete": false/);
  const prepared = bridgeCalls.find(x => x.type === "PREPARE_LONG_CONTEXT");
  assert.equal(prepared.strategy, "centered");
  assert.equal(prepared.anchorSelection, selected);
});

test("non-page content over budget fails before any model request or summary", async t => {
  const { panel, calls } = await setup(t, 8192);
  panel.state.history = [{ role: "user", content: "超長對話".repeat(10000) }];
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(calls.length, 0);
  assert.match(panel.elements.toast.textContent, /Context window/);
});

test("three comparison pages share one context budget and exclude the current page", async t => {
  const f = await setup(t, 16384);
  const pages = [1, 2, 3].map(tabId => ({ tabId, title: `Page ${tabId}`, url: `https://example.com/${tabId}`,
    text: f.text.slice(0, 16000), originalChars: f.text.length, truncated: true }));
  f.panel.state.comparedPages = pages;
  const storage = f.api.runtime.sendMessage;
  f.api.runtime.sendMessage = async message => {
    if (message.type === "READ_READING_TABS") return { ok: true, pages };
    if (message.type === "PREPARE_LONG_TABS") return { ok: true, plans: pages.map(page => ({
      ...page, snapshotId: `snapshot${page.tabId}`, totalChars: f.text.length, batchCount: 6,
      context: selectCenteredContext({ ...page, text: f.text, truncated: false }, { budgetTokens: message.budgetTokens, prefix: `T${page.tabId}P`, anchorOffset: f.text.length - 20 }),
    })) };
    if (["VALIDATE_LONG_TAB", "RELEASE_LONG_TAB"].includes(message.type)) return { ok: true };
    return storage(message);
  };
  await f.panel.submitPrompt({ preventDefault() {} });
  assert.equal(f.calls.length, 1, f.panel.elements.toast.textContent);
  const messages = f.calls[0].messages;
  assert.ok(estimateRequestTokens(messages) <= requestInputBudget({ contextWindowTokens: 16384 }));
  const payload = JSON.parse(messages.at(-1).content.split("\n\n").slice(1).join("\n\n"));
  assert.equal(payload.current_page, undefined);
  assert.equal(payload.comparison_pages.length, 3);
  assert.ok(payload.comparison_pages.every(page => page.coverage.complete === false));
});

test("changed snapshot blocks the only provider request", async t => {
  const f = await setup(t);
  f.invalidate();
  await f.panel.submitPrompt({ preventDefault() {} });
  assert.equal(f.calls.length, 0);
  assert.match(f.panel.elements.toast.textContent, /snapshot changed/);
});

test("full-page preparation makes one real loopback HTTP answer request", async t => {
  const f = await setup(t);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "Synthetic answer." }, finish_reason: "stop" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  f.data.settings.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  f.panel.state.settings = { ...f.data.settings };
  f.panel.dom.window.fetch = fetch;
  await f.panel.submitPrompt({ preventDefault() {} });
  assert.equal(requests.length, 1, f.panel.elements.toast.textContent);
  const content = requests[0].messages.at(-1).content;
  const payload = JSON.parse(content.split("\n\n").slice(1).join("\n\n"));
  assert.ok(payload.current_page.sources.map(source => source.text).join("") === f.text, "the complete original UTF-8 body survives real HTTP transport");
});

test("stopping the single answer aborts without starting batch requests", async t => {
  const { panel, bridgeCalls } = await setup(t);
  let start;
  const ready = new Promise(resolve => { start = resolve; });
  panel.dom.window.fetch = (_url, options) => {
    start();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  const pending = panel.submitPrompt({ preventDefault() {} });
  await ready;
  await panel.submitPrompt({ preventDefault() {} });
  await pending;
  assert.equal(panel.elements.sendButton.disabled, false);
  assert.equal(bridgeCalls.some(x => x.type === "READ_LONG_BATCH"), false);
});
