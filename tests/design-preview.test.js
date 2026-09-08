import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

async function preview(t) {
  const root = new URL("../design/safari-sidebar/", import.meta.url);
  const dom = new JSDOM(await readFile(new URL("index.html", root), "utf8"), { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.eval(await readFile(new URL("preview.js", root), "utf8"));
  return dom.window;
}

test("preview IDs are unique across icons and interactive regions", async (t) => {
  const window = await preview(t);
  const ids = [...window.document.querySelectorAll("[id]")].map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("design preview is isolated and never sends submitted text", async (t) => {
  const window = await preview(t);
  const document = window.document;
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(policy, /connect-src 'none'/);
  let requests = 0;
  window.fetch = () => { requests++; throw new Error("unexpected network"); };
  document.getElementById("newButton").click();
  const prompt = document.getElementById("prompt");
  prompt.value = '<img src="https://example.com/test">';
  prompt.dispatchEvent(new window.Event("input"));
  document.getElementById("composer").dispatchEvent(new window.Event("submit", { cancelable: true }));
  assert.equal(requests, 0);
  assert.equal(document.querySelector("#transcript .question:last-child").textContent, '<img src="https://example.com/test">');
  assert.equal(document.querySelectorAll("#transcript img").length, 0);
  assert.match(document.getElementById("notice").textContent, /沒有送出/);
});

test("design preview supports appearance, history filtering, and closing menus", async (t) => {
  const window = await preview(t);
  const byId = (id) => window.document.getElementById(id);
  byId("appearanceButton").click();
  assert.equal(window.document.documentElement.dataset.appearance, "dark");
  byId("historyButton").click();
  assert.equal(byId("history").hidden, false);
  assert.equal(window.document.querySelector("section.chat-view").hidden, true);
  byId("historySearch").value = "不存在";
  byId("historySearch").dispatchEvent(new window.Event("input"));
  assert.equal(byId("noResults").hidden, false);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(byId("chat").hidden, false);
  byId("modelButton").click();
  assert.equal(byId("modelMenu").hidden, false);
  window.document.querySelector('[data-model="ChatGPT"]').click();
  assert.match(byId("modelButton").textContent, /ChatGPT/);
  assert.equal(byId("modelMenu").hidden, true);
});

test("design preview attachments can be removed and never capture the page", async (t) => {
  const window = await preview(t);
  const document = window.document;
  document.querySelector('[data-attachment="畫面截圖"]').click();
  const attachments = document.getElementById("attachments");
  assert.equal(attachments.children.length, 1);
  attachments.firstChild.click();
  assert.equal(attachments.hidden, true);
});
