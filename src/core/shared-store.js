import { DEFAULT_SETTINGS, mergeSettings } from "./settings.js";
import { normalizeConversationStore, upsertConversation } from "./conversation.js";
import { assertEndpointSecurity } from "./openai.js";

function validateSettingsPatch(patch) {
  mergeSettings(patch);
  if (Object.keys(patch).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) {
    throw new TypeError("設定包含不支援的欄位");
  }
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

  async function readConversations() {
    const saved = await storageLocal.get("conversations");
    return normalizeConversationStore(saved.conversations);
  }

  function patchSettings(patch, expected = {}, afterCommit, beforeCommit) {
    return mutate(async () => {
      validateSettingsPatch(patch);
      validateSettingsPatch(expected);
      const settings = await readSettings();
      for (const [key, value] of Object.entries(expected)) {
        if (settings[key] !== value && settings[key] !== patch[key]) {
          const error = new Error("設定已在另一個頁面變更，請重新開啟設定後再儲存");
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

  function appendConversation(id, messages) {
    return mutate(async () => {
      if (typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 128) {
        throw new TypeError("對話識別碼無效");
      }
      if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some((message) =>
        !message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" || message.content.length > 200_000)) {
        throw new TypeError("對話紀錄的新增訊息格式無效");
      }
      const current = await readConversations();
      const existing = current.conversations.find((conversation) => conversation.id === id);
      const next = upsertConversation(current, {
        id,
        title: existing?.title,
        updatedAt: Date.now(),
        messages: [...(existing?.messages ?? []), ...messages],
      });
      await storageLocal.set({ conversations: next });
      return next;
    });
  }

  function selectConversation(id) {
    return mutate(async () => {
      const current = await readConversations();
      if (id !== null && !current.conversations.some((conversation) => conversation.id === id)) {
        throw new Error("找不到要開啟的對話，請重新載入對話紀錄");
      }
      const next = { ...current, activeConversationId: id };
      await storageLocal.set({ conversations: next });
      return next;
    });
  }

  return { patchSettings, appendConversation, selectConversation, readSettings, readConversations };
}
