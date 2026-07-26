export function compactText(input, maxLength = 32_000) {
  const normalized = String(input ?? "").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return "…";
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function computeCropBox(rect, viewport, image) {
  const scaleX = image.width / viewport.width;
  const scaleY = image.height / viewport.height;

  const left = Math.max(0, Math.min(image.width, rect.left * scaleX));
  const top = Math.max(0, Math.min(image.height, rect.top * scaleY));
  const right = Math.max(left, Math.min(image.width, (rect.left + rect.width) * scaleX));
  const bottom = Math.max(top, Math.min(image.height, (rect.top + rect.height) * scaleY));

  const x = Math.round(left);
  const y = Math.round(top);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right) - x),
    height: Math.max(1, Math.round(bottom) - y),
  };
}

export function describeElementData({
  tagName,
  id,
  classes = [],
  ariaLabel,
  text,
  cssPath,
}) {
  const tag = compactText(tagName || "element", 40).toLowerCase();
  const idPart = id ? `#${compactText(id, 120)}` : "";
  const classPart = [...new Set(classes.filter(Boolean))]
    .slice(0, 4)
    .map((name) => `.${compactText(name, 80)}`)
    .join("");
  const result = { element: compactText(`${tag}${idPart}${classPart}`, 480) };

  if (ariaLabel) result.label = compactText(ariaLabel, 240);
  if (text) result.text = compactText(text, 500);
  if (cssPath) result.path = compactText(cssPath, 500);

  return result;
}

export function hasCaptureLayoutChanged(before, after, tolerance = 0.5) {
  const pairs = [
    [before?.viewport?.width, after?.viewport?.width],
    [before?.viewport?.height, after?.viewport?.height],
    [before?.scroll?.x, after?.scroll?.x],
    [before?.scroll?.y, after?.scroll?.y],
    [before?.rect?.left, after?.rect?.left],
    [before?.rect?.top, after?.rect?.top],
    [before?.rect?.width, after?.rect?.width],
    [before?.rect?.height, after?.rect?.height],
  ];
  return pairs.some(([left, right]) =>
    !Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > tolerance,
  );
}

export function pickerActionForKey(key, shiftKey = false) {
  if (key === "Escape") return { type: "cancel" };
  if (key === "Enter") return { type: "confirm" };
  if (key === "Tab") return { type: "navigate", direction: shiftKey ? -1 : 1 };
  return null;
}

export function nextPickerIndex(currentIndex, direction, candidateCount) {
  if (candidateCount <= 0) return -1;
  if (currentIndex < 0) return direction < 0 ? candidateCount - 1 : 0;
  return (currentIndex + direction + candidateCount) % candidateCount;
}

export function rectIntersectsViewport(rect, viewport) {
  return Boolean(
    rect &&
      viewport &&
      rect.width > 2 &&
      rect.height > 2 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewport.width &&
      rect.top < viewport.height,
  );
}
