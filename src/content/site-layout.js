import { PAGE_LAYOUT_ATTRIBUTE } from "../core/panel-layout.js";

// X keeps fixed-width columns even after its outer flex container shrinks.
// Keep secondary-column internals at their authored width; shrink the article.
export function siteLayoutCSS(hostname, availableWidth) {
  if (!["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname)) return "";
  const root = `html[${PAGE_LAYOUT_ATTRIBUTE}]`;
  return `
    ${root} main, ${root} main > div, ${root} [data-testid="primaryColumn"] {
      min-width: 0 !important;
      max-width: 100% !important;
      flex-shrink: 1 !important;
    }
    ${root} [data-testid="sidebarColumn"] {
      flex-shrink: 0 !important;
      ${availableWidth < 1000 ? "display: none !important;" : ""}
    }
  `;
}
