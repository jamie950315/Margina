import { createSharedStore } from "../core/shared-store.js";
import { extensionOrigin } from "../core/bridge.js";
import { endpointOriginPattern, removeEndpointPermission } from "../core/permissions.js";

const stores = new WeakMap();
const types = new Set(["PATCH_SETTINGS", "APPEND_CONVERSATION", "SELECT_CONVERSATION"]);

function isPanel(sender, api) {
  if (sender?.id !== api.runtime.id || !sender.url) return false;
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
  if (!stores.has(api)) stores.set(api, createSharedStore(api.storage.local));
  const store = stores.get(api);
  return (async () => {
    try {
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
