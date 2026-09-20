import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { panelHarness } from "./helpers/panel-harness.js";

// Load the same cascade as the shipped page. The regular panel harness does not
// load linked styles, so behavior-only tests cannot detect framework overrides.
async function styledPanel(t) {
  const panel = await panelHarness();
  t.after(() => panel.dom.window.close());
  const document = panel.dom.window.document;
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  for (const link of links) {
    const href = link.getAttribute("href");
    assert.doesNotMatch(href, /^(?:https?:)?\/\//, "runtime styles must remain local");
    if (href.startsWith("assets/katex/")) continue;
    const source = href.startsWith("vendor/") ? `../src/${href}` : `../src/panel/${href}`;
    const style = document.createElement("style");
    style.textContent = await readFile(new URL(source, import.meta.url), "utf8");
    document.head.append(style);
  }
  await panel.initialize();
  return panel;
}

test("Apple theme loads local framework controls before the SafAI adaptation", async t => {
  const panel = await styledPanel(t);
  const document = panel.dom.window.document;
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute("href"));
  for (const module of ["buttons", "forms", "segmented-controls"]) {
    const index = styles.indexOf(`vendor/puppertino/${module}.css`);
    assert.ok(index >= 0, `${module} is included`);
    assert.ok(index < styles.indexOf("apple-theme.css"), "local overrides load last");
  }
  assert.ok(styles.indexOf("panel.css") < styles.indexOf("apple-theme.css"));
  assert.equal(document.querySelector('script[src*="puppertino"]'), null, "framework scripting must not replace the existing controls");
});

test("the combined framework cascade keeps dismissed sheets and popovers hidden", async t => {
  const panel = await styledPanel(t);
  const document = panel.dom.window.document;
  for (const id of ["readingSheet", "previewOverlay", "modeMenu", "attachMenu", "historyDrawer"]) {
    const element = document.getElementById(id);
    assert.equal(element.hidden, true);
    assert.equal(panel.dom.window.getComputedStyle(element).display, "none", id);
  }
  assert.equal(panel.dom.window.getComputedStyle(document.getElementById("settingsSheet")).visibility, "hidden");
});

test("Apple styling preserves keyboard-accessible settings inputs", async t => {
  const panel = await styledPanel(t);
  const document = panel.dom.window.document;
  document.getElementById("settingsSheet").classList.add("is-open");
  for (const id of ["streamInput"]) {
    const input = document.getElementById(id);
    const style = panel.dom.window.getComputedStyle(input);
    assert.equal(input.type, "checkbox");
    assert.notEqual(style.display, "none", id);
    assert.notEqual(style.visibility, "hidden", id);
    assert.equal(input.closest(".p-form-switch,.p-form-checkbox-cont"), null,
      "upstream markup-dependent checkbox classes cannot wrap SafAI labels");
  }
  assert.equal(document.getElementById("contextWindowInput").type, "number");
  assert.equal(document.getElementById("contextWindowInput").value, "262144");
  assert.equal(document.getElementById("apiKeyInput").type, "password");
  assert.equal(document.getElementById("apiKeyInput").autocomplete, "off");
});

test("dynamically created reading controls receive the Apple adaptation without altering their semantics", async t => {
  const panel = await styledPanel(t);
  const document = panel.dom.window.document;
  document.getElementById("quickPromptsButton").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const sheet = document.getElementById("readingSheet");
  assert.equal(sheet.hidden, false);
  const use = sheet.querySelector(".command-use");
  assert.equal(use.classList.contains("p-btn"), true);
  const name = sheet.querySelector('input:not([type="checkbox"])');
  const prompt = sheet.querySelector("textarea");
  for (const field of [name, prompt]) {
    assert.equal(field.classList.contains("p-form-text"), true);
    assert.equal(field.classList.contains("p-form-no-validate"), true,
      "free text must not receive a success/error color merely for being nonempty");
    field.focus();
    assert.equal(document.activeElement, field);
  }
  const checkbox = sheet.querySelector('input[type="checkbox"]');
  assert.notEqual(panel.dom.window.getComputedStyle(checkbox).display, "none");
  assert.equal(checkbox.closest(".p-form-checkbox-cont,.p-form-switch"), null);
  use.click();
  assert.equal(sheet.hidden, true);
  assert.equal(document.activeElement, panel.elements.promptInput);
  assert.equal(panel.state.history.length, 0, "styling must not auto-send a quick prompt");
});

test("Apple adaptation retains explicit appearance, transparency and motion fallbacks", async () => {
  const theme = await readFile(new URL("../src/panel/apple-theme.css", import.meta.url), "utf8");
  assert.match(theme, /prefers-color-scheme:\s*dark/);
  assert.match(theme, /prefers-reduced-transparency:\s*reduce/);
  assert.match(theme, /prefers-reduced-motion:\s*reduce/);
  assert.match(theme, /-webkit-backdrop-filter\s*:/, "Safari 15.4 needs the prefixed backdrop filter");
  assert.doesNotMatch(theme, /@import\b|url\(["']?https?:/i, "no remote runtime assets");
});

test("dark macOS material stays dark over white pages and matches the embedded host", async () => {
  const theme = await readFile(new URL("../src/panel/apple-theme.css", import.meta.url), "utf8");
  const host = await readFile(new URL("../src/content/index.js", import.meta.url), "utf8");
  const dark = theme.split("@media (prefers-color-scheme:dark)")[1].split("html,body")[0];
  assert.match(dark, /--canvas:#1e1e1e;/);
  assert.match(dark, /--p-btn-def-bg:#343434;/);
  const [, r, g, b, opacity] = dark.match(/--material:rgba\((\d+),(\d+),(\d+),([.\d]+)\)/);
  const alpha = Number(opacity);
  for (const channel of [r, g, b]) {
    const onWhite = Number(channel) * alpha + 255 * (1 - alpha);
    assert.ok(onWhite <= 61, "a white webpage must not wash the dark material into mid-gray");
  }
  assert.ok(host.includes(`rgba(${r}, ${g}, ${b}, ${opacity})`), "host and panel preview share the same material");
  assert.match(host, /\.panel-material \{ background: #1e1e1e; \}/, "opaque dark fallback remains equally dark");
});

test("macOS redesign groups toolbar actions and keeps detailed reading choices out of the default composer", async t => {
  const panel = await styledPanel(t);
  const doc = panel.dom.window.document;
  assert.equal(doc.querySelector('.toolbar-actions #newChatButton')?.type, 'button');
  assert.ok(doc.querySelector('.toolbar-actions #settingsButton'));
  assert.equal(doc.getElementById('longModeRow'), null);
  assert.equal(doc.getElementById('contextCoverage').textContent, '', 'ordinary page does not repeat verbose context prose above the composer');
  assert.equal(doc.querySelectorAll('.quick-card').length, 3);
  assert.equal(doc.querySelectorAll('.quick-card svg[aria-hidden="true"]').length, 3);
  assert.doesNotMatch(doc.querySelector('.quick-grid').textContent, /↵/);
  doc.getElementById('modelButton').click();
  assert.equal(doc.getElementById('modeMenu').hidden, false);
  assert.equal(doc.getElementById('longMode'), null);
  assert.equal(doc.getElementById('longConfirm'), null);
});
