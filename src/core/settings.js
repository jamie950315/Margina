import { resolveChatCompletionsUrl } from "./openai.js";
import { parseQuickPrompts } from "./quick-prompts.js";

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "api",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  includePage: true,
  includeSelection: true,
  stream: true,
  selectionTools: true,
  selectionToolsDisabledSites: "",
  quickPrompts: "",
  contextWindowTokens: 262144,
});

export function mergeSettings(saved = {}) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new TypeError("儲存的設定格式錯誤，請重新設定");
  }
  const settings = { ...DEFAULT_SETTINGS };
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) continue;
    if (typeof saved[key] !== typeof fallback) {
      throw new TypeError(`儲存的設定 ${key} 格式錯誤，請重新設定`);
    }
    settings[key] = saved[key];
  }
  if (settings.mode !== "api" && settings.mode !== "chatgpt") {
    throw new TypeError("儲存的模式設定錯誤，請重新設定");
  }
  if (!Number.isInteger(settings.contextWindowTokens) ||
      settings.contextWindowTokens < 8192 || settings.contextWindowTokens > 2097152) {
    throw new TypeError("儲存的 contextWindowTokens 設定錯誤，請重新設定");
  }
  parseQuickPrompts(settings.quickPrompts);
  parseDisabledSelectionSites(settings.selectionToolsDisabledSites);
  return settings;
}

export function selectionSiteHostname(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.replace(/\.$/u, "") : "";
  } catch { return ""; }
}

export function parseDisabledSelectionSites(value) {
  const invalid = () => { throw new TypeError("儲存的網站選單設定格式錯誤，請重新設定"); };
  if (typeof value !== "string" || value.length > 26_000) return invalid();
  if (!value) return [];
  const sites = value.split("\n");
  if (sites.length > 100 || sites.some(site => site.length > 253 ||
      !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/u.test(site) ||
      selectionSiteHostname(`https://${site}/`) !== site)) return invalid();
  return [...new Set(sites)];
}

export function selectionToolsEnabled(settings, url) {
  const hostname = selectionSiteHostname(url);
  return Boolean(settings.selectionTools && hostname &&
    !parseDisabledSelectionSites(settings.selectionToolsDisabledSites).includes(hostname));
}

export class SettingsMutationCoordinator {
  #sequence = 0;
  #current = null;

  get kind() {
    return this.#current?.kind ?? null;
  }

  begin(kind, settings) {
    if (this.#current) return null;
    const mutation = Object.freeze({
      id: ++this.#sequence,
      kind,
      settings: Object.freeze({ ...settings }),
    });
    this.#current = mutation;
    return mutation;
  }

  isCurrent(mutation) {
    return Boolean(mutation && this.#current?.id === mutation.id);
  }

  end(mutation) {
    if (this.isCurrent(mutation)) this.#current = null;
  }

  invalidate() {
    this.#sequence += 1;
    this.#current = null;
  }
}

export function providerConfigurationChanged(previous, next) {
  let previousEndpoint;
  let nextEndpoint;
  try {
    previousEndpoint = resolveChatCompletionsUrl(previous?.baseUrl);
  } catch {
    previousEndpoint = String(previous?.baseUrl ?? "").trim();
  }
  try {
    nextEndpoint = resolveChatCompletionsUrl(next?.baseUrl);
  } catch {
    nextEndpoint = String(next?.baseUrl ?? "").trim();
  }
  return Boolean(
    previousEndpoint !== nextEndpoint ||
      String(previous?.apiKey ?? "") !== String(next?.apiKey ?? "") ||
      String(previous?.model ?? "") !== String(next?.model ?? ""),
  );
}
