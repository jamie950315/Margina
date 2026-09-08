import test from "node:test";
import assert from "node:assert/strict";
import { collectAnnotations } from "../src/core/annotations.js";
test("annotations preserve ordered passages without duplicating the live selection", () => {
  assert.deepEqual(collectAnnotations([" First ", "Second"], "Second"), ["First", "Second"]);
  assert.deepEqual(collectAnnotations(["First"], "Third"), ["First", "Third"]);
  assert.deepEqual(collectAnnotations([], ""), []);
  assert.throws(() => collectAnnotations(Array.from({ length: 11 }, (_, i) => String(i))), /10 段/);
  assert.throws(() => collectAnnotations(["x".repeat(16000)], "y"), /16,000/);
});
