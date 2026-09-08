// Compensate viewport-fixed controls without moving the page into a wrapper.
// Wrapping/transforming the body would break sticky/fixed scrolling and selectors.
export function createFixedPageLayout(document, viewportWidth) {
  const view = document.defaultView;
  const changed = new Map();
  const candidates = new Set();
  const dirty = new Set();
  let reserved = 0;
  let frame;
  function scheduleRefresh() {
    if (!reserved || frame != null) return;
    frame = view.setTimeout(() => {
      frame = undefined;
      refresh();
    }, 100);
  }
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") dirty.add(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === 1) dirty.add(node);
    }
    if (!dirty.size) return;
    scheduleRefresh();
  });

  function restore() {
    for (const [element, properties] of changed) {
      for (const [name, { value, priority, applied }] of properties) {
        // A site's newer inline edit belongs to the site, not to us.
        if (element.style.getPropertyValue(name) !== applied ||
            element.style.getPropertyPriority(name) !== "important") continue;
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    }
    changed.clear();
  }

  function set(element, name, value) {
    let properties = changed.get(element);
    if (!properties) changed.set(element, properties = new Map());
    properties.set(name, {
      value: element.style.getPropertyValue(name),
      priority: element.style.getPropertyPriority(name),
      applied: value,
    });
    element.style.setProperty(name, value, "important");
  }

  function viewportFixed(element) {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = view.getComputedStyle(parent);
      if ((style.transform && style.transform !== "none") ||
          (style.perspective && style.perspective !== "none") ||
          (style.filter && style.filter !== "none") ||
          /paint|layout|strict|content/.test(style.contain) ||
          /transform|perspective|filter/.test(style.willChange)) return false;
    }
    return true;
  }

  function refresh() {
    observer.disconnect();
    restore();
    const available = Math.max(1, viewportWidth() - reserved);
    // The extension host and picker are siblings of body, outside this scan.
    const adjustments = [];
    for (const target of dirty) {
      if (!target.isConnected) continue;
      for (const element of [target, ...target.querySelectorAll("*")]) {
        if (view.getComputedStyle(element).position === "fixed") candidates.add(element);
      }
    }
    dirty.clear();
    for (const element of candidates) {
      if (!element.isConnected) { candidates.delete(element); continue; }
      const style = view.getComputedStyle(element);
      if (style.position !== "fixed") { candidates.delete(element); continue; }
      if (!viewportFixed(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.right <= available || rect.left >= viewportWidth()) continue;
      adjustments.push({ element, width: rect.width, right: Number.parseFloat(style.right) });
    }
    for (const { element, width, right } of adjustments) {
      if (width > available) {
        set(element, "box-sizing", "border-box");
        set(element, "min-width", "0px");
        set(element, "max-width", `${available}px`);
      }
      // Preserve the existing right gutter; left-anchored full-width bars keep left.
      if (Number.isFinite(right)) set(element, "right", `${right + reserved}px`);
      const rect = element.getBoundingClientRect();
      const left = Number.parseFloat(view.getComputedStyle(element).left);
      const shift = rect.left < 0 ? -rect.left : Math.min(0, available - rect.right);
      if (Number.isFinite(left) && shift) {
        set(element, "left", `${left + shift}px`);
      }
    }
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
  }

  return {
    rescan() {
      if (document.body) dirty.add(document.body);
      scheduleRefresh();
    },
    apply(width) {
      if (!reserved && document.body) dirty.add(document.body);
      reserved = Math.max(0, width);
      if (reserved) refresh();
      else this.clear();
    },
    clear() {
      reserved = 0;
      observer.disconnect();
      if (frame != null) view.clearTimeout(frame);
      frame = undefined;
      restore();
      candidates.clear();
      dirty.clear();
    },
  };
}
