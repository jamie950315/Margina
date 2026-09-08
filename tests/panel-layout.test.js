import test from "node:test";
import assert from "node:assert/strict";

async function loadPanelLayout() {
  try {
    return await import("../src/core/panel-layout.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return {};
    throw error;
  }
}

test("clampPanelWidth keeps the panel and webpage readable", async () => {
  const { clampPanelWidth } = await loadPanelLayout();

  assert.equal(clampPanelWidth?.(100, 1_200), 320);
  assert.equal(clampPanelWidth?.(900, 1_200), 720);
  assert.equal(clampPanelWidth?.(700, 800), 440);
  assert.equal(clampPanelWidth?.(Number.NaN, 1_200), 342);
  assert.equal(clampPanelWidth?.(424, 300), 276);
});

test("panelWidthFromDrag grows leftward and shrinks rightward", async () => {
  const { panelWidthFromDrag } = await loadPanelLayout();

  assert.equal(
    panelWidthFromDrag?.({
      startWidth: 424,
      startX: 900,
      currentX: 750,
      viewportWidth: 1_200,
    }),
    574,
  );
  assert.equal(
    panelWidthFromDrag?.({
      startWidth: 424,
      startX: 900,
      currentX: 100,
      viewportWidth: 1_200,
    }),
    720,
  );
  assert.equal(
    panelWidthFromDrag?.({
      startWidth: 424,
      startX: 900,
      currentX: 1_100,
      viewportWidth: 1_200,
    }),
    320,
  );
});

test("panelWidthFromKey offers accessible resize steps", async () => {
  const { panelWidthFromKey } = await loadPanelLayout();

  assert.equal(
    panelWidthFromKey?.({
      width: 424,
      key: "ArrowLeft",
      shiftKey: false,
      viewportWidth: 1_200,
    }),
    440,
  );
  assert.equal(
    panelWidthFromKey?.({
      width: 424,
      key: "ArrowRight",
      shiftKey: true,
      viewportWidth: 1_200,
    }),
    376,
  );
  assert.equal(
    panelWidthFromKey?.({
      width: 424,
      key: "Enter",
      shiftKey: false,
      viewportWidth: 1_200,
    }),
    null,
  );
});

test("page layout controller applies, updates, and restores the webpage inset", async () => {
  const {
    createPageLayoutController,
    PAGE_LAYOUT_ATTRIBUTE,
    PAGE_ORIGINAL_PADDING_PROPERTY,
    PAGE_PANEL_WIDTH_PROPERTY,
  } = await loadPanelLayout();
  assert.equal(typeof createPageLayoutController, "function");

  const attributes = new Set();
  const properties = new Map([["color", "red"]]);
  const root = {
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => attributes.add(name),
    removeAttribute: (name) => attributes.delete(name),
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  };
  let paddingReads = 0;
  const controller = createPageLayoutController(root, () => {
    paddingReads += 1;
    return paddingReads === 1 ? "12px" : "999px";
  });

  controller.apply(424);
  assert.equal(attributes.has(PAGE_LAYOUT_ATTRIBUTE), true);
  assert.equal(properties.get(PAGE_ORIGINAL_PADDING_PROPERTY), "12px");
  assert.equal(properties.get(PAGE_PANEL_WIDTH_PROPERTY), "424px");

  controller.apply(512);
  assert.equal(paddingReads, 1);
  assert.equal(properties.get(PAGE_ORIGINAL_PADDING_PROPERTY), "12px");
  assert.equal(properties.get(PAGE_PANEL_WIDTH_PROPERTY), "512px");

  controller.clear();
  assert.equal(attributes.has(PAGE_LAYOUT_ATTRIBUTE), false);
  assert.equal(properties.has(PAGE_ORIGINAL_PADDING_PROPERTY), false);
  assert.equal(properties.has(PAGE_PANEL_WIDTH_PROPERTY), false);
  assert.equal(properties.get("color"), "red");
});

test("cssPropertyName converts JavaScript style names for setProperty", async () => {
  const { cssPropertyName } = await loadPanelLayout();

  assert.equal(cssPropertyName?.("zIndex"), "z-index");
  assert.equal(cssPropertyName?.("maxWidth"), "max-width");
  assert.equal(cssPropertyName?.("pointerEvents"), "pointer-events");
  assert.equal(cssPropertyName?.("border-radius"), "border-radius");
  assert.equal(cssPropertyName?.("--safai-width"), "--safai-width");
});
