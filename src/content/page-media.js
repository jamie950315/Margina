// Accessible stylesheet breakpoints can follow the space left beside the panel.
// Cross-origin sheets remain untouched; Safari does not expose their CSS rules.
export function shiftedWidthQuery(query, reserved, fontSize = 16) {
  return query.replace(/\(\s*((?:min-|max-)?width)\s*:\s*(\d*\.?\d+)(px|em|rem)\s*\)/gi,
    (_, feature, number, unit) => `(${feature}: ${Number(number) + reserved / (unit.toLowerCase() === "px" ? 1 : fontSize)}${unit})`);
}

export function createPageMediaLayout(document, onChange) {
  const changed = new Map();
  const view = document.defaultView;
  let width = 0;
  let timer;

  function restore() {
    for (const [media, { original, applied }] of changed) {
      if (media.mediaText === applied) media.mediaText = original;
    }
    changed.clear();
  }

  function rulesFor(sheet) {
    try { return sheet.cssRules ?? []; }
    catch (error) {
      if (error.name === "SecurityError") return [];
      throw error;
    }
  }

  function update() {
    restore();
    // CSS media em/rem are based on the initial font size, not the page's font.
    const probe = document.createElement("span");
    probe.dataset.safaiLayoutProbe = "";
    probe.style.cssText = "all:initial!important;font-size:medium!important;position:absolute!important;visibility:hidden!important";
    document.documentElement.append(probe);
    const font = Number.parseFloat(view.getComputedStyle(probe).fontSize) || 16;
    probe.remove();
    function adjust(media) {
      if (!media) return;
      const original = media.mediaText;
      const next = shiftedWidthQuery(original, width, font);
      if (next !== original) {
        media.mediaText = next;
        changed.set(media, { original, applied: media.mediaText });
      }
    }
    function visit(rules) {
      for (const rule of rules) {
        adjust(rule.media);
        if (rule.styleSheet) visit(rulesFor(rule.styleSheet));
        else if (rule.cssRules) visit(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) {
      adjust(sheet.media);
      visit(rulesFor(sheet));
    }
  }

  function schedule() {
    if (!width || timer != null) return;
    timer = view.setTimeout(() => {
      timer = undefined;
      update();
      onChange?.();
    }, 100);
  }
  function stylesheetNode(node) {
    return node.nodeType === 1 && (node.matches('style, link[rel~="stylesheet"]') || node.querySelector('style, link[rel~="stylesheet"]'));
  }
  function loaded(event) {
    if (event.target.matches?.('link[rel~="stylesheet"]')) schedule();
  }
  const observer = new view.MutationObserver((records) => {
    if (records.some(record => record.target.parentElement?.closest('style') ||
      record.target.nodeName === 'STYLE' ||
      [...record.addedNodes, ...record.removedNodes].some(stylesheetNode))) schedule();
  });
  return {
    apply(nextWidth) {
      width = nextWidth;
      update();
      if (document.head) observer.observe(document.head, { subtree: true, childList: true, characterData: true });
      document.addEventListener("load", loaded, true);
    },
    clear() {
      width = 0;
      observer.disconnect();
      document.removeEventListener("load", loaded, true);
      view.clearTimeout(timer);
      timer = undefined;
      restore();
    },
  };
}
