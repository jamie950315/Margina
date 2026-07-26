const FOCUSABLE_SELECTOR = "a[href], button, input, select, textarea, [tabindex]";

function focusableDescendants(element) {
  const controls = Array.from(element.querySelectorAll(FOCUSABLE_SELECTOR));
  if (element.matches?.(FOCUSABLE_SELECTOR)) controls.unshift(element);
  return controls;
}

export function createInertController(windowObject) {
  const supportsNativeInert = "inert" in windowObject.HTMLElement.prototype;
  const fallbackStates = new WeakMap();

  return (element, inactive) => {
    if (!element) return;
    const inert = Boolean(inactive);
    if (supportsNativeInert) {
      element.inert = inert;
      return;
    }

    if (inert) {
      let state = fallbackStates.get(element);
      if (!state) {
        state = {
          ariaHidden: element.getAttribute("aria-hidden"),
          controls: new Map(),
        };
        fallbackStates.set(element, state);
      }
      for (const control of focusableDescendants(element)) {
        if (!state.controls.has(control)) {
          state.controls.set(control, {
            disabled: "disabled" in control ? control.disabled : undefined,
            tabIndex: control.getAttribute("tabindex"),
          });
        }
        if ("disabled" in control) control.disabled = true;
        control.setAttribute("tabindex", "-1");
      }
      element.classList.add("safai-inert-fallback");
      element.setAttribute("aria-hidden", "true");
      return;
    }

    const state = fallbackStates.get(element);
    if (!state) {
      element.classList.remove("safai-inert-fallback");
      return;
    }
    for (const [control, snapshot] of state.controls) {
      if (snapshot.disabled !== undefined) control.disabled = snapshot.disabled;
      if (snapshot.tabIndex === null) control.removeAttribute("tabindex");
      else control.setAttribute("tabindex", snapshot.tabIndex);
    }
    if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", state.ariaHidden);
    element.classList.remove("safai-inert-fallback");
    fallbackStates.delete(element);
  };
}
