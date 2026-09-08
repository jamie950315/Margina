import test from "node:test";
import assert from "node:assert/strict";
import { parseQuickPrompts, serializeQuickPrompts } from "../src/core/quick-prompts.js";
test("quick prompts support custom ordering, empty list and bounded validation", () => {
  const items = parseQuickPrompts().reverse();
  assert.deepEqual(parseQuickPrompts(serializeQuickPrompts(items)), items);
  assert.deepEqual(parseQuickPrompts("[]"), []);
  assert.throws(() => parseQuickPrompts('{bad'));
  assert.throws(() => serializeQuickPrompts([items[0], items[0]]));
  assert.throws(() => serializeQuickPrompts([{ id: 'x', title: 'x', prompt: 'x'.repeat(2001) }]));
});
