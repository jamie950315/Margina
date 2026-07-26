import createDOMPurify from "dompurify";

const FORBIDDEN_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "img",
  "video",
  "audio",
];

const FORBIDDEN_ATTRIBUTES = [
  "id",
  "name",
  "src",
  "srcset",
  "action",
  "formaction",
];

function isSafeLink(href) {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function createMessageSanitizer(windowObject) {
  const purifier = createDOMPurify(windowObject);
  return (html) => {
    const fragment = purifier.sanitize(String(html ?? ""), {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true, svg: true, mathMl: true },
      FORBID_TAGS: FORBIDDEN_TAGS,
      FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
      ALLOW_DATA_ATTR: false,
    });

    for (const anchor of fragment.querySelectorAll("a")) {
      const href = anchor.getAttribute("href") || "";
      if (!isSafeLink(href)) {
        anchor.replaceWith(windowObject.document.createTextNode(anchor.textContent || ""));
        continue;
      }
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
    }
    return fragment;
  };
}
