import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("conversation history announces itself as a modal dialog", async () => {
  const html = await readFile(new URL("../src/panel/panel.html", import.meta.url), "utf8");
  const dom = new JSDOM(html);
  const drawer = dom.window.document.getElementById("historyDrawer");
  const title = dom.window.document.getElementById("historyTitle");

  assert.equal(drawer.getAttribute("role"), "dialog");
  assert.equal(drawer.getAttribute("aria-modal"), "true");
  assert.equal(drawer.getAttribute("aria-labelledby"), "historyTitle");
  assert.equal(title.textContent, "對話紀錄");
});
