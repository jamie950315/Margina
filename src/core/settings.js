import { resolveChatCompletionsUrl } from "./openai.js";

export const DEFAULT_SETTINGS = Object.freeze({
  mode: "api",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  includePage: true,
  includeSelection: true,
  stream: true,
});

function stringOr(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function booleanOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function mergeSettings(saved = {}) {
  return {
    mode: saved.mode === "api" || saved.mode === "chatgpt" ? saved.mode : DEFAULT_SETTINGS.mode,
    baseUrl: stringOr(saved.baseUrl, DEFAULT_SETTINGS.baseUrl),
    apiKey: stringOr(saved.apiKey, DEFAULT_SETTINGS.apiKey),
    model: stringOr(saved.model, DEFAULT_SETTINGS.model),
    includePage: booleanOr(saved.includePage, DEFAULT_SETTINGS.includePage),
    includeSelection: booleanOr(saved.includeSelection, DEFAULT_SETTINGS.includeSelection),
    stream: booleanOr(saved.stream, DEFAULT_SETTINGS.stream),
  };
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
