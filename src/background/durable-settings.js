import { DEFAULT_SETTINGS, mergeSettings } from "../core/settings.js";

export function usesNativeSettings(api) {
  return new URL(api.runtime.getURL("panel.html")).protocol === "safari-web-extension:";
}

function failure(code) {
  const error = new Error(code === "SETTINGS_CONFLICT"
    ? "設定已在另一個頁面變更，請重新開啟設定後再儲存"
    : "無法確認 macOS 設定是否讀取或儲存成功；請保留此頁，稍後重新開啟設定檢查");
  if (code === "SETTINGS_CONFLICT") error.code = code;
  return error;
}

function nativeRequest(api, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(undefined, true), 10_000);
    function finish(value, failed = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed || value?.ok !== true) { reject(failure(value?.code)); return; }
      try {
        if (!Object.hasOwn(value, "settings")) throw failure();
        if (value.settings !== null && (!value.settings ||
            Object.keys(value.settings).length !== Object.keys(DEFAULT_SETTINGS).length ||
            Object.keys(DEFAULT_SETTINGS).some(key => !Object.hasOwn(value.settings, key)))) throw failure();
        resolve(value.settings === null ? null : mergeSettings(value.settings));
      } catch { reject(failure()); }
    }
    try {
      const returned = api.runtime.sendNativeMessage("dev.jamie.safai", message, value => {
        // Consume lastError here; never expose native diagnostics or paths.
        finish(value, Boolean(api.runtime.lastError));
      });
      if (returned && typeof returned.then === "function") returned.then(value => finish(value), () => finish(undefined, true));
    } catch { finish(undefined, true); }
  });
}

// Keychain is the authoritative Safari settings store, not a fallback/cache.
// Browser storage is consulted only to import a pre-existing installation once.
export function createDurableSettings(api) {
  return {
    async read() {
      const saved = await nativeRequest(api, { action: "settings.read" });
      if (saved !== null) return saved;
      const legacy = await api.storage.local.get("settings");
      const settings = mergeSettings(legacy.settings);
      try {
        const imported = await nativeRequest(api, { action: "settings.write", settings, expected: null });
        if (imported === null || Object.keys(settings).some(key => settings[key] !== imported[key])) throw failure();
        return settings;
      } catch (error) {
        if (error.code !== "SETTINGS_CONFLICT") throw error;
        // Another context completed the first import. Read its winner; do not
        // replay our write or overwrite it with the legacy snapshot.
        const winner = await nativeRequest(api, { action: "settings.read" });
        if (winner === null) throw failure();
        return winner;
      }
    },
    async write(settings, expected) {
      const result = await nativeRequest(api, { action: "settings.write", settings, expected });
      if (result === null || Object.keys(settings).some(key => settings[key] !== result[key])) throw failure();
    },
  };
}
