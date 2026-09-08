// The only per-frame work is numeric style interpolation. Stylesheet discovery
// and fixed-element measurement belong to the transition endpoints, not here.
export function createPanelMotion({ view, render, settle, duration = 250 }) {
  let value = 0;
  let target = 0;
  let frame;
  let timer;
  let generation = 0;
  function cancel() {
    generation += 1;
    if (frame != null) view.cancelAnimationFrame(frame);
    if (timer != null) view.clearTimeout(timer);
    frame = timer = undefined;
  }
  function finish() {
    cancel();
    value = target;
    render(value);
    settle(value);
  }
  return {
    get value() { return value; },
    finish,
    to(next, { immediate = false } = {}) {
      cancel();
      target = next;
      const from = value;
      if (immediate || from === next || !view.matchMedia ||
          view.matchMedia('(prefers-reduced-motion: reduce)').matches ||
          view.document?.visibilityState === 'hidden') {
        finish();
        return;
      }
      const token = generation;
      const start = view.performance.now();
      function tick(now) {
        if (token !== generation) return;
        const progress = Math.min(1, Math.max(0, (now - start) / duration));
        value = from + (target - from) * (1 - (1 - progress) ** 3);
        render(value);
        if (progress === 1) finish();
        else frame = view.requestAnimationFrame(tick);
      }
      frame = view.requestAnimationFrame(tick);
      // Background/stalled painting must never leave the page partially resized.
      timer = view.setTimeout(finish, duration + 100);
    },
  };
}
