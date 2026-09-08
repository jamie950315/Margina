import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelMotion } from '../src/content/panel-motion.js';

function harness(reduced = false) {
  let now = 0;
  let frame;
  let timer;
  const rendered = [];
  const settled = [];
  const view = {
    performance: { now: () => now },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = undefined; },
    setTimeout: fn => { timer = fn; return 2; },
    clearTimeout: () => { timer = undefined; },
  };
  const motion = createPanelMotion({ view, render: v => rendered.push(v), settle: v => settled.push(v) });
  return { motion, rendered, settled, advance(n) { now = n; const fn = frame; frame = undefined; fn?.(now); }, stall() { timer?.(); } };
}

test('opening and closing interpolate and settle the exact endpoint', () => {
  const h = harness();
  h.motion.to(342);
  h.advance(100);
  assert.ok(h.motion.value > 0 && h.motion.value < 342);
  h.advance(250);
  assert.deepEqual(h.settled, [342]);
  h.motion.to(0);
  h.advance(350);
  assert.ok(h.motion.value > 0 && h.motion.value < 342);
  h.advance(500);
  assert.deepEqual(h.settled, [342, 0]);
});

test('rapid reversal starts from the current position without a stale completion', () => {
  const h = harness();
  h.motion.to(342);
  h.advance(60);
  const midway = h.motion.value;
  h.motion.to(0);
  assert.equal(h.motion.value, midway);
  h.advance(90);
  assert.ok(h.motion.value < midway);
  h.motion.to(342);
  h.advance(340);
  assert.deepEqual(h.settled, [342]);
});

test('capture, resizing, reduced motion and stalled paints settle synchronously or boundedly', () => {
  const h = harness();
  h.motion.to(342);
  h.advance(40);
  h.motion.finish();
  assert.equal(h.motion.value, 342);
  h.motion.to(500, { immediate: true });
  assert.equal(h.motion.value, 500);
  h.motion.to(0);
  h.stall();
  assert.equal(h.motion.value, 0);
  const reduced = harness(true);
  reduced.motion.to(342);
  assert.deepEqual(reduced.settled, [342]);
});
