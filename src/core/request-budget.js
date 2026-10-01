import { t } from "../i18n/index.js";
import { estimateTokens } from "./context-budget.js";

// Arbitrary OpenAI-compatible providers do not expose a shared tokenizer.
// Images need a separate allowance: their base64 transport size is not tokens.
export function estimateRequestTokens(messages) {
  let images = 0;
  const textOnly = messages.map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map(part => {
      if (part.type !== "image_url") return part;
      images++;
      return { type: "image_url" };
    }) : message.content,
  }));
  return estimateTokens(JSON.stringify(textOnly)) + messages.length * 16 + images * 4096;
}

export function requestInputBudget(settings) {
  const window = settings.contextWindowTokens;
  if (!Number.isSafeInteger(window) || window < 8192 || window > 2097152) throw new Error(t("Context window 必須是 8192 至 2097152 之間的整數"));
  return window - Math.min(8192, Math.floor(window / 4));
}

export function pageTokenBudget(settings, messagesWithoutPages, pageCount = 1) {
  const remaining = requestInputBudget(settings) - estimateRequestTokens(messagesWithoutPages);
  if (remaining < pageCount * 256) throw new Error(t("問題、對話紀錄或附件已接近 Context window 上限；請開始新對話、減少附件或調高容量"));
  // Try the entire remaining allowance first so a fitting document stays whole.
  // The caller measures full serialization and re-selects locally if needed.
  return Math.floor(remaining / pageCount);
}
