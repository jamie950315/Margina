import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const root = new URL("../src/native/welcome/", import.meta.url);
const html = await readFile(new URL("Main.html", root), "utf8");
const script = await readFile(new URL("Script.js", root), "utf8");

function page() {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.eval(script);
  return dom;
}

test("native welcome explains setup and local account persistence without remote resources", () => {
  const { window } = page();
  const document = window.document;
  assert.equal(document.documentElement.lang, "zh-Hant");
  assert.equal(document.querySelector("h1").textContent, "讓 ChatGPT 留在閱讀旁邊");
  assert.equal(document.querySelectorAll(".steps li").length, 3);
  assert.match(document.querySelector(".account-note").textContent, /鑰匙圈.*關閉 Safari.*登出.*切換帳號.*登入到期/);
  assert.equal(document.querySelector("#extension-status").getAttribute("role"), "status");
  assert.equal(document.querySelectorAll("button").length, 1);
  for (const element of document.querySelectorAll("[src], [href]")) {
    assert.match(element.getAttribute("src") || element.getAttribute("href"), /^\.\.\/(Icon\.png|Style\.css|Script\.js)$/);
  }
  assert.match(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /default-src 'none'/);
  assert.doesNotMatch(html + script, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|window\.close|退出並|Quit and/);
  window.close();
});

test("native welcome show function handles enabled, disabled and unavailable states accessibly", () => {
  const { window } = page();
  const status = window.document.querySelector("#extension-status");
  window.show(true, true);
  assert.equal(status.dataset.state, "on");
  assert.match(status.textContent, /已啟用/);
  window.show(false, false);
  assert.equal(status.dataset.state, "off");
  assert.match(status.textContent, /偏好設定/);
  assert.match(window.document.querySelector("button").textContent, /偏好設定/);
  window.show(undefined, true);
  assert.equal(status.dataset.state, "unknown");
  assert.match(status.textContent, /尚未確認/);
  window.close();
});

test("native welcome only opens existing native settings action and reports unavailable bridge", () => {
  const { window } = page();
  const actions = [];
  window.webkit = { messageHandlers: { controller: { postMessage: value => actions.push(value) } } };
  window.document.querySelector("button").click();
  assert.deepEqual(actions, ["open-preferences"]);
  delete window.webkit;
  assert.doesNotThrow(() => window.document.querySelector("button").click());
  assert.equal(window.document.querySelector("#extension-status").dataset.state, "error");
  assert.match(window.document.querySelector("#extension-status").textContent, /請到 Safari/);
  window.close();
});
