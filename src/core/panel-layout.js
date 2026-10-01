// Reserved page space includes the floating sidebar's two 10px gutters.
export const DEFAULT_PANEL_WIDTH = 342;
export const MIN_PANEL_WIDTH = 320;
export const MAX_PANEL_WIDTH = 720;
export const MIN_PAGE_WIDTH = 360;
export const MIN_VIEWPORT_GUTTER = 24;
export const PAGE_LAYOUT_ATTRIBUTE = "data-safai-extension-panel-open";
export const PAGE_PANEL_WIDTH_PROPERTY = "--safai-extension-panel-width";

export function cssPropertyName(property) {
  const name = String(property ?? "");
  if (name.startsWith("--")) return name;
  return name.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

export function panelWidthBounds(viewportWidth) {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const viewportCap = Math.max(0, viewport - MIN_VIEWPORT_GUTTER);
  const min = Math.min(MIN_PANEL_WIDTH, viewportCap);
  const pageAwareMax = Math.max(0, viewport - MIN_PAGE_WIDTH);
  const max = Math.max(min, Math.min(MAX_PANEL_WIDTH, pageAwareMax));
  return { min, max };
}

export function clampPanelWidth(width, viewportWidth) {
  const { min, max } = panelWidthBounds(viewportWidth);
  const requested = Number.isFinite(width) ? width : DEFAULT_PANEL_WIDTH;
  return Math.min(max, Math.max(min, requested));
}

export function panelWidthFromDrag({
  startWidth,
  startX,
  currentX,
  viewportWidth,
}) {
  const dragDistance =
    Number.isFinite(startX) && Number.isFinite(currentX) ? startX - currentX : 0;
  return clampPanelWidth(startWidth + dragDistance, viewportWidth);
}

export function panelWidthFromKey({ width, key, shiftKey, viewportWidth }) {
  const direction = key === "ArrowLeft" ? 1 : key === "ArrowRight" ? -1 : 0;
  if (direction === 0) return null;
  const step = shiftKey ? 48 : 16;
  return clampPanelWidth(width + direction * step, viewportWidth);
}

export function createPageLayoutController(root) {
  return {
    apply(width) {
      if (!root?.style || !Number.isFinite(width)) return;
      if (!root.hasAttribute(PAGE_LAYOUT_ATTRIBUTE)) {
        root.setAttribute(PAGE_LAYOUT_ATTRIBUTE, "");
      }
      root.style.setProperty(PAGE_PANEL_WIDTH_PROPERTY, `${Math.max(0, width)}px`);
    },
    clear() {
      if (!root?.style) return;
      root.removeAttribute(PAGE_LAYOUT_ATTRIBUTE);
      root.style.removeProperty(PAGE_PANEL_WIDTH_PROPERTY);
    },
  };
}
