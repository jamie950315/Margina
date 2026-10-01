import { t } from "../i18n/index.js";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings.js";
import { normalizeConversationStore, upsertConversation, validateConversationPageKey, SAVED_PAGE_SELECTION_LIMIT } from "./conversation.js";
import { assertEndpointSecurity } from "./openai.js";

function validateSettingsPatch(patch) {
  mergeSettings(patch);
  if (Object.keys(patch).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) {
    throw new TypeError(t("設定包含不支援的欄位"));
  }
}

function withPageSelection(store, pageKey, id) {
  // Updating an entry also refreshes its position in the bounded mapping.
  const entries = Object.entries(store.pageSelections).filter(([key]) => key !== pageKey);
  entries.push([pageKey, id]);
  return { ...store, pageSelections: Object.fromEntries(entries.slice(-SAVED_PAGE_SELECTION_LIMIT)) };
}

export function createSharedStore(storageLocal, settingsStorage = null) {
  let queue = Promise.resolve();
  function mutate(operation) {
    const result = queue.then(operation);
    // A failed write rejects its caller, but must not block subsequent writes.
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function readSettings() {
    if (settingsStorage) return settingsStorage.read();
    const saved = await storageLocal.get("settings");
    return mergeSettings(saved.settings);
  }

  async function loadConversations() {
    const saved = await storageLocal.get("conversations");
    return normalizeConversationStore(saved.conversations);
  }

  function readConversations() {
    return mutate(loadConversations);
  }

  function patchSettings(patch, expected = {}, afterCommit, beforeCommit) {
    return mutate(async () => {
      validateSettingsPatch(patch);
      validateSettingsPatch(expected);
      const settings = await readSettings();
      for (const [key, value] of Object.entries(expected)) {
        if (settings[key] !== value && settings[key] !== patch[key]) {
          const error = new Error(t("設定已在另一個頁面變更，請重新開啟設定後再儲存"));
          error.code = "SETTINGS_CONFLICT";
          throw error;
        }
      }
      const next = mergeSettings({ ...settings, ...patch });
      assertEndpointSecurity(next.baseUrl, next.apiKey);
      if (beforeCommit) await beforeCommit(settings, next);
      if (settingsStorage) await settingsStorage.write(next, settings);
      else await storageLocal.set({ settings: next });
      if (afterCommit) await afterCommit(settings, next);
      return next;
    });
  }

  function appendConversation(id, messages, pageKey) {
    return mutate(async () => {
      if (pageKey !== undefined) validateConversationPageKey(pageKey);
      if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 128) {
        throw new TypeError(t("對話識別碼無效"));
      }
      if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some((message) =>
        !message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" || message.content.length > 200_000)) {
        throw new TypeError(t("對話紀錄的新增訊息格式無效"));
      }
      const current = await loadConversations();
      const existing = current.conversations.find((conversation) => conversation.id === id);
      if (pageKey !== undefined && existing?.pageKey !== undefined && existing.pageKey !== pageKey) {
        throw new Error(t("這個對話屬於另一個網頁，請另開新對話"));
      }
      let next = upsertConversation(current, {
        id,
        title: existing?.title,
        pageKey: existing?.pageKey ?? pageKey,
        updatedAt: Date.now(),
        messages: [...(existing?.messages ?? []), ...messages],
      });
      if (pageKey !== undefined) next = withPageSelection(next, pageKey, id);
      await storageLocal.set({ conversations: next });
      return next;
    });
  }

  function selectConversation(id, pageKey) {
    return mutate(async () => {
      if (pageKey !== undefined) validateConversationPageKey(pageKey);
      const current = await loadConversations();
      const existing = current.conversations.find(conversation => conversation.id === id);
      if (id !== null && !existing) {
        throw new Error(t("找不到要開啟的對話，請重新載入對話紀錄"));
      }
      if (pageKey !== undefined && existing?.pageKey !== undefined && existing.pageKey !== pageKey) {
        throw new Error(t("這個對話屬於另一個網頁，請另開新對話"));
      }
      let next = { ...current, activeConversationId: id,
        conversations: pageKey !== undefined && existing?.pageKey === undefined && existing
          ? current.conversations.map(conversation => conversation.id === id ? { ...conversation, pageKey } : conversation)
          : current.conversations,
      };
      if (pageKey !== undefined) next = withPageSelection(next, pageKey, id);
      await storageLocal.set({ conversations: next });
      return next;
    });
  }

  return { patchSettings, appendConversation, selectConversation, readSettings, readConversations };
}
