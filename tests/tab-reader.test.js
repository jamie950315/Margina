import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";

const source = buildSync({ entryPoints: ["src/content/tab-reader.js"], bundle: true, write: false, format: "iife" }).outputFiles[0].text;

test("bundled tab reader reads and locates real DOM without initializing sidebar or reading settings", (t) => {
  const dom = new JSDOM("<!doctype html><title>Sample</title><main><p>This is the original sentence.</p></main>", {
    url: "https://example.com/article?private=1#source", runScripts: "outside-only", pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  dom.window.eval(source);
  const page = dom.window.__safaiReadPage();
  assert.equal(page.title, "Sample");
  assert.equal(page.url, "https://example.com/article");
  assert.equal(page.text, "This is the original sentence.");
  assert.equal(dom.window.document.querySelector("iframe"), null);
  assert.equal(dom.window.document.querySelector("[data-safai-reading-tools]"), null);
  assert.equal(dom.window.__safaiTogglePanel, undefined);
  assert.equal(dom.window.__safaiLocateQuote({ url: page.url, quote: "original sentence" }).ok, true);
  assert.equal(dom.window.__safaiLocateQuote({ url: page.url, quote: "not in this page" }).ok, false);
});

test("manifest requests persistent general web access and injects selection tools only into top documents", () => {
  const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  assert.ok(manifest.permissions.includes("tabs"));
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0], {
    matches: ["http://*/*", "https://*/*"], js: ["content-script.js"], all_frames: false, run_at: "document_idle",
  });
  assert.ok(!manifest.web_accessible_resources.some((entry) => entry.resources.includes("reader-script.js")));
});
