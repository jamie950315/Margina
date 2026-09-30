import test from "node:test";
import assert from "node:assert/strict";
import { panelHarness } from "./helpers/panel-harness.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { handleStorageMessage } from "../src/background/storage.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

async function setup(t, messages = []) {
  const data = { settings: { ...DEFAULT_SETTINGS }, conversations: {
    activeConversationId: "saved", conversations: messages.length
      ? [{ id: "saved", title: "Synthetic history", pageKey: "test:https://fixture.example/", updatedAt: 1, messages }] : [],
  } };
  const api = {
    runtime: { id: "test", getURL: path => `https://extension.test/${path}` },
    permissions: { contains: async () => true },
    storage: { onChanged: { addListener() {}, removeListener() {} }, local: {
      get: async key => ({ [key]: data[key] }), set: async patch => Object.assign(data, patch),
    } },
  };
  api.runtime.sendMessage = message => handleStorageMessage(message, { id: "test", url: api.runtime.getURL("panel.html") }, api);
  const panel = await panelHarness({ demo: false, browser: api });
  t.after(() => panel.dom.window.close());
  panel.dom.window.TextDecoder = TextDecoder;
  const frames = new Map();
  let frameId = 0, layoutReads = 0;
  panel.dom.window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  panel.dom.window.cancelAnimationFrame = id => frames.delete(id);
  Object.defineProperty(panel.elements.conversation, "scrollHeight", { get: () => { layoutReads++; return 100; } });
  panel.connectBridge(() => ({ ok: true, page: { title: "Fixture", url: "https://fixture.example/", text: "Synthetic page context" }, selection: "", contextRevision: 0 }));
  await panel.initialize();
  panel.elements.promptInput.value = "Synthetic question";
  return { panel, frames, reads: () => layoutReads, flush() {
    const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0));
  } };
}

test("a burst of stream deltas does not rebuild text or force layout for every token", async t => {
  const h = await setup(t);
  h.panel.dom.window.fetch = async () => new Response(Array.from({ length: 200 }, () => delta("x")).join("") + finish, { headers: { "Content-Type": "text/event-stream" } });
  await h.panel.submitPrompt({ preventDefault() {} });
  assert.equal(h.panel.state.history.at(-1).content, "x".repeat(200));
  assert.equal(h.panel.elements.messageList.querySelector(".assistant .message-content").textContent.trim(), "x".repeat(200));
  assert.ok(h.reads() <= 3, `expected at most three layout reads, got ${h.reads()}`);
  assert.equal(h.frames.size, 0, "completion cancels the pending frame");
});

test("stream frames append to one text node and final Markdown is rendered immediately", async t => {
  const h = await setup(t);
  let stream;
  h.panel.dom.window.fetch = async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "text/event-stream" } });
  const sending = h.panel.submitPrompt({ preventDefault() {} });
  while (!stream) await tick();
  const write = text => stream.enqueue(new TextEncoder().encode(text));
  write(delta("**First")); await tick();
  assert.equal(h.frames.size, 1);
  h.flush();
  const content = h.panel.elements.messageList.querySelector(".assistant .message-content");
  const textNode = content.firstChild;
  assert.equal(content.textContent, "**First");
  write(delta(" second**")); await tick(); h.flush();
  assert.equal(content.firstChild, textNode, "earlier output is not replaced at each frame");
  assert.equal(content.textContent, "**First second**");
  write(delta(" done") + finish); stream.close(); await sending;
  assert.equal(content.querySelector("strong").textContent, "First second");
  assert.match(content.textContent, /done/);
  assert.equal(h.frames.size, 0);
});

test("stopping before a render frame preserves received text and cancels pending paints", async t => {
  const h = await setup(t);
  h.panel.state.retainedSelections = ["Unfinished annotated passage"];
  let stream;
  h.panel.dom.window.fetch = async (_, options) => new Response(new ReadableStream({ start(controller) {
    stream = controller;
    options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const sending = h.panel.submitPrompt({ preventDefault() {} });
  while (!stream) await tick();
  assert.equal(h.panel.elements.selectionCard.hidden, true, "submitted annotation previews leave the composer while answering");
  stream.enqueue(new TextEncoder().encode(delta("Received partial answer")));
  await tick();
  assert.equal(h.frames.size, 1);
  await h.panel.submitPrompt({ preventDefault() {} });
  await sending;
  assert.equal(h.frames.size, 0);
  assert.equal(h.panel.state.history.at(-1).content, "Received partial answer");
  assert.equal(h.panel.elements.messageList.querySelector(".typing-caret"), null);
  assert.equal(h.panel.state.retainedSelections[0], "Unfinished annotated passage");
  assert.equal(h.panel.elements.selectionCard.hidden, false, "stopped requests restore annotations for retry");
});

test("restoring a transcript reads the final scroll height once", async t => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Message ${index}` }));
  const h = await setup(t, messages);
  assert.equal(h.panel.elements.messageList.querySelectorAll(".message").length, 20);
  assert.equal(h.reads(), 1);
});
