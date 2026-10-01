// Animate the private panel surface on the compositor. Page reflow and layout
// discovery must not run in animation frames or hold up the first panel paint.
export function createPanelMotion({ view, render, settle, animate, duration = 250 }) {
  let value = 0;
  let target = 0;
  let from = 0;
  let start = 0;
  let animation;
  let timer;
  let generation = 0;
  function currentValue() {
    if (!animation) return value;
    const progress = Math.min(1, Math.max(0, (view.performance.now() - start) / duration));
    return from + (target - from) * (1 - (1 - progress) ** 3);
  }
  function cancel() {
    generation += 1;
    animation?.cancel();
    if (timer != null) view.clearTimeout(timer);
    animation = timer = undefined;
  }
  function finish() {
    cancel();
    value = target;
    render(value);
    settle(value);
  }
  return {
    get value() { return currentValue(); },
    finish,
    to(next, { immediate = false } = {}) {
      from = currentValue();
      cancel();
      value = from;
      target = next;
      if (immediate || from === next || !view.matchMedia ||
          view.matchMedia('(prefers-reduced-motion: reduce)').matches ||
          view.document?.visibilityState === 'hidden') {
        finish();
        return;
      }
      const token = generation;
      start = view.performance.now();
      render(from);
      animation = animate(from, target, {
        duration, easing: 'cubic-bezier(0.333333, 1, 0.666667, 1)', fill: 'both',
      });
      animation.onfinish = () => { if (token === generation) finish(); };
      // Hidden/stalled callbacks must never leave an offscreen panel active.
      timer = view.setTimeout(finish, duration + 100);
    },
  };
}
