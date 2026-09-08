import test from "node:test";
import assert from "node:assert/strict";

import {
  cssPathFor,
  readPageContext,
  readSelectedText,
  resolveRememberedSelection,
  sanitizePageUrl,
} from "../src/content/page-reader.js";

test("sanitizePageUrl removes credentials, query parameters, and fragments", () => {
  assert.equal(
    sanitizePageUrl("https://user:secret@example.com/account?token=sensitive#oauth-state"),
    "https://example.com/account",
  );
});

test("sanitizePageUrl rejects malformed URLs instead of forwarding unsanitized metadata", () => {
  assert.throws(() => sanitizePageUrl("https://[invalid]?token=sensitive"), TypeError);
});

test("readSelectedText never reads a password field", () => {
  const documentObject = {
    activeElement: {
      tagName: "INPUT",
      type: "password",
      value: "secret password",
      selectionStart: 0,
      selectionEnd: 15,
    },
  };
  assert.equal(readSelectedText(documentObject, { getSelection: () => null }), "");
});

test("readSelectedText returns the webpage selection", () => {
  const windowObject = { getSelection: () => ({ toString: () => "  highlighted words  " }) };
  const documentObject = { activeElement: null };

  assert.equal(readSelectedText(documentObject, windowObject), "highlighted words");
});

test("readSelectedText reads a selection inside an input", () => {
  const documentObject = {
    activeElement: {
      tagName: "TEXTAREA",
      value: "before selected after",
      selectionStart: 7,
      selectionEnd: 15,
    },
  };
  const windowObject = { getSelection: () => ({ toString: () => "" }) };

  assert.equal(readSelectedText(documentObject, windowObject), "selected");
});

test("readSelectedText reads an input selection nested in open shadow roots", () => {
  const input = {
    tagName: "INPUT",
    value: "before shadow selection after",
    selectionStart: 7,
    selectionEnd: 23,
  };
  const innerHost = {
    tagName: "INNER-FIELD",
    shadowRoot: { activeElement: input },
  };
  const documentObject = {
    activeElement: {
      tagName: "OUTER-FIELD",
      shadowRoot: { activeElement: innerHost },
    },
  };
  const windowObject = { getSelection: () => ({ toString: () => "" }) };

  assert.equal(readSelectedText(documentObject, windowObject), "shadow selection");
});

test("readSelectedText caps an excessive selection before it crosses the bridge", () => {
  const windowObject = { getSelection: () => ({ toString: () => "x".repeat(20_000) }) };

  const selected = readSelectedText({ activeElement: null }, windowObject);

  assert.equal(selected.length, 16_000);
  assert.match(selected, /…$/);
});

test("resolveRememberedSelection preserves an input selection while focus moves into the panel", () => {
  assert.equal(
    resolveRememberedSelection({
      current: "",
      previous: "selected input text",
      panelFocused: true,
    }),
    "selected input text",
  );
  assert.equal(
    resolveRememberedSelection({
      current: "",
      previous: "selected input text",
      panelFocused: false,
    }),
    "",
  );
});

test("readPageContext prefers the main readable region and caps its length", () => {
  const documentObject = {
    title: "Long article",
    location: { href: "https://example.com/long" },
    querySelector(selector) {
      assert.equal(selector, "main, article, [role='main']");
      return { innerText: `  Main\n ${"x".repeat(40_000)}  ` };
    },
    body: { innerText: "navigation" },
  };

  const context = readPageContext(documentObject);

  assert.equal(context.title, "Long article");
  assert.equal(context.url, "https://example.com/long");
  assert.equal(context.text.length, 32_000);
  assert.match(context.text, /^Main x/);
  assert.match(context.text, /…$/);
});

test("readPageContext caps attacker-controlled title and URL metadata", () => {
  const documentObject = {
    title: "t".repeat(10_000),
    location: { href: `https://example.com/${"u".repeat(10_000)}` },
    querySelector: () => ({ innerText: "content" }),
  };

  const context = readPageContext(documentObject);
  assert.ok(context.title.length <= 512);
  assert.ok(context.url.length <= 4_096);
});

test("cssPathFor builds a stable short path with an id boundary", () => {
  const main = { nodeType: 1, tagName: "MAIN", id: "content", parentElement: null };
  const section = {
    nodeType: 1,
    tagName: "SECTION",
    id: "",
    classList: ["card"],
    parentElement: main,
    previousElementSibling: null,
  };
  const button = {
    nodeType: 1,
    tagName: "BUTTON",
    id: "",
    classList: ["buy", "primary"],
    parentElement: section,
    previousElementSibling: null,
  };

  assert.equal(cssPathFor(button), "main#content > section.card > button.buy.primary");
});
