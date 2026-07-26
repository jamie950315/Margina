import test from "node:test";
import assert from "node:assert/strict";

import {
  compactText,
  computeCropBox,
  describeElementData,
  hasCaptureLayoutChanged,
  nextPickerIndex,
  pickerActionForKey,
  rectIntersectsViewport,
} from "../src/core/page-context.js";

test("compactText normalizes webpage whitespace", () => {
  assert.equal(compactText("  Hello \n\t Safari   AI  ", 50), "Hello Safari AI");
});

test("compactText adds an ellipsis without exceeding the content limit", () => {
  assert.equal(compactText("1234567890", 6), "12345…");
});

test("computeCropBox scales a DOM rectangle to screenshot pixels", () => {
  assert.deepEqual(
    computeCropBox(
      { left: 100, top: 50, width: 200, height: 100 },
      { width: 1000, height: 500 },
      { width: 2000, height: 1000 },
    ),
    { x: 200, y: 100, width: 400, height: 200 },
  );
});

test("computeCropBox clamps an element crossing the viewport edge", () => {
  assert.deepEqual(
    computeCropBox(
      { left: -20, top: 450, width: 100, height: 100 },
      { width: 1000, height: 500 },
      { width: 2000, height: 1000 },
    ),
    { x: 0, y: 900, width: 160, height: 100 },
  );
});

test("describeElementData returns concise user-visible element metadata", () => {
  assert.deepEqual(
    describeElementData({
      tagName: "BUTTON",
      id: "checkout",
      classes: ["primary", "large"],
      ariaLabel: "前往結帳",
      text: "立即購買",
      cssPath: "main > button#checkout",
    }),
    {
      element: "button#checkout.primary.large",
      label: "前往結帳",
      text: "立即購買",
      path: "main > button#checkout",
    },
  );
});

test("describeElementData caps attacker-controlled identifiers and classes", () => {
  const result = describeElementData({
    tagName: "X".repeat(1_000),
    id: "i".repeat(1_000_000),
    classes: Array(4).fill("c".repeat(1_000_000)),
  });

  assert.ok(result.element.length <= 500);
});

test("hasCaptureLayoutChanged detects scroll, viewport, or element movement", () => {
  const stable = {
    viewport: { width: 1000, height: 700 },
    scroll: { x: 0, y: 120 },
    rect: { left: 10, top: 20, width: 300, height: 80 },
  };

  assert.equal(hasCaptureLayoutChanged(stable, structuredClone(stable)), false);
  assert.equal(
    hasCaptureLayoutChanged(stable, { ...structuredClone(stable), scroll: { x: 0, y: 121 } }),
    true,
  );
  assert.equal(
    hasCaptureLayoutChanged(stable, {
      ...structuredClone(stable),
      rect: { left: 14, top: 20, width: 300, height: 80 },
    }),
    true,
  );
});

test("pickerActionForKey supports cancel, confirm, and keyboard navigation", () => {
  assert.deepEqual(pickerActionForKey("Escape"), { type: "cancel" });
  assert.deepEqual(pickerActionForKey("Enter"), { type: "confirm" });
  assert.deepEqual(pickerActionForKey("Tab", false), { type: "navigate", direction: 1 });
  assert.deepEqual(pickerActionForKey("Tab", true), { type: "navigate", direction: -1 });
  assert.equal(pickerActionForKey("ArrowRight"), null);
});

test("nextPickerIndex starts at the first or last keyboard candidate", () => {
  assert.equal(nextPickerIndex(-1, 1, 4), 0);
  assert.equal(nextPickerIndex(-1, -1, 4), 3);
  assert.equal(nextPickerIndex(3, 1, 4), 0);
  assert.equal(nextPickerIndex(0, -1, 4), 3);
  assert.equal(nextPickerIndex(-1, 1, 0), -1);
});

test("rectIntersectsViewport rejects offscreen and zero-size picker targets", () => {
  const viewport = { width: 400, height: 700 };
  assert.equal(
    rectIntersectsViewport({ left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 }, viewport),
    true,
  );
  assert.equal(
    rectIntersectsViewport({ left: 10, top: 800, right: 110, bottom: 850, width: 100, height: 50 }, viewport),
    false,
  );
  assert.equal(
    rectIntersectsViewport({ left: 500, top: 20, right: 600, bottom: 70, width: 100, height: 50 }, viewport),
    false,
  );
  assert.equal(
    rectIntersectsViewport({ left: 10, top: 20, right: 10, bottom: 20, width: 0, height: 0 }, viewport),
    false,
  );
});
