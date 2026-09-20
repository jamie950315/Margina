// Apply only Puppertino's safe, presentational modules. Keep native inputs and
// existing event/focus handling; upstream JS and hidden-input patterns are unused.
export function installAppleControls(doc) {
  const rules = [
    [".primary-button", ["p-btn", "p-btn-sm", "p-prim-col"]],
    [".reading-button, .citation-button, .secondary-button", ["p-btn", "p-btn-sm"]],
    ["#settingsForm input:not([type='checkbox']), .reading-content input:not([type='checkbox']), .reading-content textarea", ["p-form-text", "p-form-no-validate"]],
    [".mode-switch", ["p-segmented-controls"]],
    [".long-mode", ["p-form-select"]],
  ];
  function decorate(root) {
    if (!root?.querySelectorAll) return;
    const candidates = [...(root.nodeType === 1 ? [root] : []), ...root.querySelectorAll("button,input,textarea,select,.mode-switch,.long-mode")];
    for (const element of candidates) {
      for (const [selector, names] of rules) {
        if (element.matches(selector)) element.classList.add(...names);
      }
    }
  }
  decorate(doc);
  const observer = new doc.defaultView.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) decorate(node);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
