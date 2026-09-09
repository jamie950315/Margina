import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../src/relay/preview.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/relay/preview.html", import.meta.url), "utf8");
const bootstrap = "c".repeat(64);
const controlKey = "a".repeat(64);
const providerURL = `http://safai-provider-00000000-0000-4000-8000-000000000001.localhost:45002/?__safai_key=${"b".repeat(64)}`;

async function page(t, state, authorized = true) {
  const calls = [];
  const dom = new JSDOM(html, { url: `http://safai-control-00000000-0000-4000-8000-000000000002.localhost:45001/__safai/${authorized ? `#bootstrap=${bootstrap}` : ""}`, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.fetch = async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(path === "/__safai/bootstrap" ? { controlKey } : state), { headers: { "Content-Type": "application/json" } });
  };
  dom.window.eval(source);
  await new Promise(resolve => setTimeout(resolve, 10));
  return { window: dom.window, document: dom.window.document, calls };
}

test("provider loading never overwrites independently confirmed login status", async t => {
  const message = "已確認本次登入。對話與附件功能仍需另外驗證。";
  const { window, document, calls } = await page(t, { phase: "signedIn", message, revision: 4, providerURL });
  assert.equal(document.getElementById("status").textContent, message);
  assert.match(document.getElementById("provider-status").textContent, /載入/);
  assert.equal(document.getElementById("provider").src, providerURL);
  assert.equal(window.location.hash, "");
  assert.equal(document.getElementById("cancel").hidden, false);
  assert.equal(calls[1].options.headers["X-SafAI-Control"], controlKey);
  document.getElementById("load").click();
  assert.equal(document.getElementById("status").textContent, message);
});

test("unapproved control pages do not fetch credentials or open a provider", async t => {
  const { document, calls } = await page(t, {}, false);
  assert.equal(calls.length, 0);
  assert.equal(document.getElementById("login").disabled, true);
  assert.equal(document.getElementById("provider").getAttribute("src"), null);
  assert.match(document.getElementById("status").textContent, /原生|選單列/);
});

test("a control response cannot redirect the provider frame to another website", async t => {
  const { document } = await page(t, { phase: "signedIn", message: "fixture", revision: 4, providerURL: "https://unapproved.invalid/" });
  assert.equal(document.getElementById("provider").getAttribute("src"), null);
  assert.match(document.getElementById("status").textContent, /未成功/);
});
