import { t } from "../i18n/index.js";
export const DEFAULT_QUICK_PROMPTS = Object.freeze([
  { id: "explain", title: "白話解釋", prompt: "請用白話解釋這段內容，並舉一個具體例子。" },
  { id: "notes", title: "讀書筆記", prompt: "請整理成讀書筆記，列出重點、關鍵概念與自我測驗問題。" },
  { id: "critique", title: "檢查論點", prompt: "請列出內容的主要論點、證據，以及值得質疑或需要查證的地方。" },
]);

export function parseQuickPrompts(value = "") {
  if (typeof value !== "string" || value.length > 26000) throw new TypeError(t("常用指令設定過長或格式錯誤"));
  let items;
  try { items = value ? JSON.parse(value) : DEFAULT_QUICK_PROMPTS; }
  catch { throw new TypeError(t("常用指令設定格式錯誤，請重新設定")); }
  if (!Array.isArray(items) || items.length > 12) throw new TypeError(t("最多可儲存 12 個常用指令"));
  const ids = new Set();
  return items.map(item => {
    if (!item || typeof item.id !== "string" || !/^[\w-]{1,64}$/.test(item.id) || ids.has(item.id) ||
      typeof item.title !== "string" || !item.title.trim() || item.title.length > 32 ||
      typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 2000) {
      throw new TypeError(t("常用指令格式錯誤：名稱限 32 字、內容限 2000 字"));
    }
    ids.add(item.id);
    return { id: item.id,
      title: value ? item.title.trim() : t(item.title.trim()),
      prompt: value ? item.prompt.trim() : t(item.prompt.trim()),
    };
  });
}

export function serializeQuickPrompts(items) {
  const value = JSON.stringify(items);
  return JSON.stringify(parseQuickPrompts(value));
}
