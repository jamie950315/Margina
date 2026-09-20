import { createSharedStore } from "../core/shared-store.js";
import { extensionOrigin } from "../core/bridge.js";
import { endpointOriginPattern, removeEndpointPermission } from "../core/permissions.js";
import { createDurableSettings, usesNativeSettings } from "./durable-settings.js";

const stores = new WeakMap();
const types = new Set(["GET_SETTINGS", "PATCH_SETTINGS", "APPEND_CONVERSATION", "SELECT_CONVERSATION"]);

export function sharedStore(api) {
  if (!stores.has(api)) stores.set(api, createSharedStore(api.storage.local,
    usesNativeSettings(api) ? createDurableSettings(api) : null));
  return stores.get(api);
}

function isPanel(sender, api) {
  if (sender?.id !== api.runtime.id || !sender.url || sender.tab?.incognito) return false;
  try {
    const expected = new URL(api.runtime.getURL("panel.html"));
    const actual = new URL(sender.url);
    return extensionOrigin(actual.href) === extensionOrigin(expected.href) && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function handleStorageMessage(message, sender, api) {
  if (!types.has(message?.type)) return undefined;
  if (!isPanel(sender, api)) return Promise.resolve({ ok: false, error: "不允許這個來源存取設定或對話" });
  const store = sharedStore(api);
  return (async () => {
    try {
      if (message.type === "GET_SETTINGS") return { ok: true, settings: await store.readSettings() };
      if (message.type === "PATCH_SETTINGS") {
        let warning = "";
        const settings = await store.patchSettings(message.patch, message.expected, async (previous, next) => {
          if (previous.baseUrl === next.baseUrl) return;
          const hosts = api.runtime.getManifest?.().host_permissions ?? [];
          // Broad website access was explicitly requested for reading tools.
          // Never remove that shared permission when an API endpoint changes.
          if (hosts.includes("https://*/*") && hosts.includes("http://*/*")) return;
          try {
            if (endpointOriginPattern(previous.baseUrl) === endpointOriginPattern(next.baseUrl)) return;
            const old = endpointOriginPattern(previous.baseUrl);
            if (await api.permissions.contains({ origins: [old] })) {
              if (!(await removeEndpointPermission(api, previous.baseUrl))) warning = "舊 API 網域權限請在 Safari 設定中移除";
            }
          } catch {
            warning = "舊 API 網域權限請在 Safari 設定中移除";
          }
        }, async (_, next) => {
          if (message.verifyPermission || ["baseUrl", "model", "apiKey"].some((key) => Object.hasOwn(message.patch, key))) {
            const allowed = await api.permissions.contains({ origins: [endpointOriginPattern(next.baseUrl)] });
            if (!allowed) throw new Error("API 網域授權已變更，請再次儲存設定以確認權限");
          }
        });
        if (usesNativeSettings(api)) {
          try {
            // Signal other panels without mirroring API credentials to Safari.
            await api.storage.local.set({ settingsRevision: crypto.randomUUID() });
          } catch {
            warning = "設定已存入 macOS；其他已開啟側欄請重新開啟以更新設定";
          }
        }
        return { ok: true, settings, warning };
      }
      const conversations = message.type === "APPEND_CONVERSATION"
        ? await store.appendConversation(message.id, message.messages)
        : await store.selectConversation(message.id);
      return { ok: true, conversations };
    } catch (error) {
      return { ok: false, error: error.message, code: error.code };
    }
  })();
}
