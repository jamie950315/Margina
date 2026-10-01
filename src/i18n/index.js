import { panelMessages } from "./panel-messages.js";
import { panelToolsMessages } from "./panel-tools-messages.js";
import { runtimeMessages } from "./runtime-messages.js";

export const LANGUAGE_PREFERENCES = Object.freeze(["auto", "en", "zh-Hant", "zh-Hans", "ja"]);
export const messages = Object.freeze({ ...runtimeMessages, ...panelToolsMessages, ...panelMessages });
// Existing source strings are stable catalog identifiers. Product entry points
// select the saved preference before rendering; pure utilities retain their source language.
let currentLanguage = "zh-Hant";
const variants = new Map();
for (const [source, translations] of Object.entries(messages)) {
  for (const translation of translations) if (!variants.has(translation)) variants.set(translation, source);
}

export function resolveLanguage(preference = "auto", languages = globalThis.navigator?.languages ?? []) {
  if (preference !== "auto" && LANGUAGE_PREFERENCES.includes(preference)) return preference;
  for (const language of languages) {
    const tag = String(language).toLowerCase().replace(/_/gu, "-");
    if (/^en(?:-|$)/u.test(tag)) return "en";
    if (/^ja(?:-|$)/u.test(tag)) return "ja";
    if (/^zh(?:-|$)/u.test(tag)) {
      if (/(?:^|-)hant(?:-|$)/u.test(tag)) return "zh-Hant";
      if (/(?:^|-)hans(?:-|$)/u.test(tag)) return "zh-Hans";
      if (/^zh-[a-z]{4}(?:-|$)/u.test(tag)) continue;
      return /(?:^|-)(?:tw|hk|mo)(?:-|$)/u.test(tag) ? "zh-Hant" : "zh-Hans";
    }
  }
  return "en";
}

export function setLanguage(preference, languages) {
  currentLanguage = resolveLanguage(preference, languages);
  return currentLanguage;
}

export function getLanguage() { return currentLanguage; }

export function t(source, values = [], language = currentLanguage) {
  const key = Object.hasOwn(messages, source) ? source : variants.get(source);
  const translation = key === undefined ? source : language === "zh-Hant" ? key
    : messages[key][{ en: 0, "zh-Hans": 1, ja: 2 }[language] ?? 0];
  return String(translation ?? "").replace(/\{(\d+)\}/gu, (match, index) =>
    index < values.length ? String(values[index]) : match);
}

// Capture only the original interface. Later page text, answers, drafts and
// saved custom prompts are never inspected or translated.
export function createDocumentLocalizer(document) {
  const text = [];
  const attributes = [];
  const walker = document.createTreeWalker(document.body, 4);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest("script,style,textarea,[contenteditable],code")) continue;
    const source = node.textContent.trim();
    if (Object.hasOwn(messages, source)) text.push({ node, source,
      prefix: node.textContent.match(/^\s*/u)[0], suffix: node.textContent.match(/\s*$/u)[0] });
  }
  for (const element of document.querySelectorAll("*")) {
    for (const name of ["aria-label", "title", "placeholder", "alt", "data-prompt"]) {
      const source = element.getAttribute(name);
      if (source && Object.hasOwn(messages, source)) attributes.push({ element, name, source });
    }
  }
  return () => {
    document.documentElement.lang = currentLanguage;
    for (const { node, source, prefix, suffix } of text) {
      if (node.isConnected) node.textContent = prefix + t(source) + suffix;
    }
    for (const { element, name, source } of attributes) {
      if (element.isConnected) element.setAttribute(name, t(source));
    }
  };
}
