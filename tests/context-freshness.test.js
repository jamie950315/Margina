import test from "node:test";
import assert from "node:assert/strict";

import { ContextFreshness } from "../src/core/context-freshness.js";

test("ContextFreshness requires a refresh after a newer page invalidation", () => {
  const freshness = new ContextFreshness();
  assert.equal(freshness.isFresh, false);

  freshness.markFresh(2);
  assert.equal(freshness.isFresh, true);
  assert.equal(freshness.revision, 2);

  freshness.invalidate(3);
  assert.equal(freshness.isFresh, false);
  assert.equal(freshness.revision, 3);

  freshness.markFresh(3);
  assert.equal(freshness.isFresh, true);
});

test("ContextFreshness ignores an older invalidation delivered after a newer snapshot", () => {
  const freshness = new ContextFreshness();
  freshness.markFresh(5);
  freshness.invalidate(4);
  assert.equal(freshness.isFresh, true);
  assert.equal(freshness.revision, 5);
});

test("ContextFreshness rejects missing or invalid snapshot revisions", () => {
  const freshness = new ContextFreshness();
  for (const revision of [undefined, null, "3", NaN, Infinity, -1, 1.5]) {
    assert.throws(() => freshness.markFresh(revision), /版本/);
    assert.equal(freshness.isFresh, false);
  }
  freshness.markFresh(2);
  freshness.invalidate();
  assert.equal(freshness.isFresh, false);
  assert.equal(freshness.revision, 2);
  freshness.markFresh(2);
  assert.equal(freshness.isFresh, true, "retrying an unchanged page can recover after a read failure");
});
