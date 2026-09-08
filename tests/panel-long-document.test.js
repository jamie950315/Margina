import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { handleStorageMessage } from "../src/background/storage.js";
import { createDocumentIndex, documentBatches, selectDocumentContext } from "../src/core/long-document.js";

async function setup(t) {
  const text = "背景資料。".repeat(7000) + "尾端答案：特殊代碼是北極星。";
  const index = createDocumentIndex({ title: "Long", url: "https://example.com/long", text });
  const batches = documentBatches(index);
  const plan = { snapshotId: "snapshot", title: index.title, url: index.url, totalChars: index.totalChars, batchCount: batches.length,
    context: selectDocumentContext(index, { query: "特殊代碼", prefix: "P" }) };
  const data = { settings: { ...DEFAULT_SETTINGS, stream: false } };
  const api = {
    runtime: { id: "test", getURL: path => `https://extension.test/${path}` },
    permissions: { contains: async () => true },
    storage: { onChanged: { addListener() {}, removeListener() {} }, local: { get: async key => ({ [key]: data[key] }), set: async patch => Object.assign(data, patch) } },
  };
  api.runtime.sendMessage = message => handleStorageMessage(message, { id: "test", url: api.runtime.getURL("panel.html") }, api);
  const panel = await panelHarness({ demo: false, browser: api }); t.after(() => panel.dom.window.close());
  panel.dom.window.TextDecoder = TextDecoder;
  const calls = [];
  const bridgeCalls = [];
  panel.dom.window.fetch = async (_, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    const isSummary = request.messages[0].content.startsWith("You summarize");
    const payload = isSummary ? JSON.parse(request.messages[1].content) : null;
    const answer = !isSummary ? "特殊代碼是北極星。" : payload.sources ? `已讀取這一批。[${payload.sources[0].id}]` : payload.summaries[0];
    return new Response(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: "stop" }] }), { headers: { "Content-Type": "application/json" } });
  };
  panel.connectBridge(message => {
    bridgeCalls.push(message.type);
    if (message.type === "REQUEST_CONTEXT") return { ok: true, page: { title: index.title, url: index.url, text: text.slice(0, 32000), truncated: true, originalChars: text.length, identity: "doc" }, selection: "", contextRevision: 0 };
    if (message.type === "PREPARE_LONG_CONTEXT") return { ok: true, plan };
    if (message.type === "READ_LONG_BATCH") return { ok: true, batch: batches[message.index] };
    return { ok: true };
  });
  await panel.initialize();
  panel.elements.promptInput.value = "特殊代碼是什麼？";
  return { panel, calls, plan, batches, bridgeCalls };
}

test("relevant mode sends tail evidence and honest coverage, not just the head", async t => {
  const { panel, calls, bridgeCalls } = await setup(t);
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages.at(-1).content, /北極星/);
  assert.match(calls[0].messages.at(-1).content, /"strategy": "relevant"/);
  assert.match(calls[0].messages.at(-1).content, /"complete": false/);
  assert.equal(bridgeCalls.filter(type => type === "RELEASE_LONG_CONTEXT").length, 1);
});

test("full mode makes no provider calls before explicit cost confirmation", async t => {
  const { panel, calls, bridgeCalls } = await setup(t);
  const doc = panel.dom.window.document;
  doc.getElementById("longMode").value = "full";
  doc.getElementById("longMode").dispatchEvent(new panel.dom.window.Event("change"));
  await panel.submitPrompt({ preventDefault() {} });
  assert.equal(doc.getElementById("longConfirm").hidden, false);
  assert.equal(calls.length, 0);
  doc.getElementById("confirmLongReading").click();
  assert.equal(calls.length, 0);
  doc.getElementById("cancelLongReading").click();
  assert.equal(doc.getElementById("longConfirm").hidden, true);
  assert.equal(calls.length, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(bridgeCalls.filter(type => type === "RELEASE_LONG_CONTEXT").length, 1);
});

test("confirmed full reading uses all batches then the summary in its final request", async t => {
  const { panel, calls, batches } = await setup(t);
  const doc = panel.dom.window.document;
  doc.getElementById("longMode").value = "full";
  doc.getElementById("longMode").dispatchEvent(new panel.dom.window.Event("change"));
  await panel.submitPrompt({ preventDefault() {} });
  doc.getElementById("longCostConsent").checked = true;
  doc.getElementById("confirmLongReading").click();
  for (let i = 0; i < 100 && panel.state.history.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(panel.state.history.length, 2, panel.elements.toast.textContent);
  assert.equal(calls.filter(call => call.messages[0].content.startsWith("You summarize") && JSON.parse(call.messages[1].content).sources).length, batches.length);
  assert.match(calls.at(-1).messages.at(-1).content, /"strategy": "full-summary"/);
  assert.match(calls.at(-1).messages.at(-1).content, /"complete": true/);
  assert.equal(panel.elements.sendButton.disabled, false);
});

test("stopping the final answer never reports the full workflow as complete", async t => {
  const { panel } = await setup(t);
  const original = panel.dom.window.fetch;
  let finalStarted;
  const ready = new Promise(resolve => { finalStarted = resolve; });
  panel.dom.window.fetch = (url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.startsWith("You summarize")) return original(url, options);
    finalStarted();
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  };
  const doc = panel.dom.window.document;
  doc.getElementById("longMode").value = "full";
  doc.getElementById("longMode").dispatchEvent(new panel.dom.window.Event("change"));
  await panel.submitPrompt({ preventDefault() {} });
  doc.getElementById("longCostConsent").checked = true;
  doc.getElementById("confirmLongReading").click();
  await ready;
  panel.elements.sendButton.click();
  for (let i = 0; i < 100 && panel.state.abortController; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(doc.getElementById("longProgress").textContent, /已停止最後回答/);
  assert.doesNotMatch(doc.getElementById("longProgress").textContent, /全文所有批次與摘要整合已完成/);
});
