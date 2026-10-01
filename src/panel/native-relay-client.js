import { t } from "../i18n/index.js";
import { extensionOrigin } from "../core/bridge.js";
import { RELAY_ACTIONS, relayState } from "../core/relay-contract.js";

function failure() {
  return new Error(t("Margina 的 ChatGPT 元件尚未回覆有效狀態；請稍後重新連線。你的草稿仍保留。"));
}

// Safari permits native messaging from the extension UI itself. This is one
// direct transport, not a fallback: a login/logout must never be replayed.
export function sendNativeRelayCommand(api, action, location = globalThis.location) {
  try {
    if (!RELAY_ACTIONS.has(action) || !api?.runtime?.id || typeof api.runtime.sendNativeMessage !== "function") throw failure();
    const expected = new URL(api.runtime.getURL("panel.html"));
    const actual = new URL(typeof location === "string" ? location : location?.href);
    if (actual.protocol !== "safari-web-extension:" || expected.protocol !== "safari-web-extension:" ||
        extensionOrigin(actual.href) !== extensionOrigin(expected.href) || actual.pathname !== expected.pathname ||
        actual.username || actual.password) throw failure();
  } catch { return Promise.reject(failure()); }

  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(value, failed = false) {
      if (settled) return;
      settled = true;
      try {
        if (failed) throw failure();
        resolve(relayState(value));
      } catch { reject(failure()); }
    }
    try {
      const returned = api.runtime.sendNativeMessage("dev.jamie.safai", { action }, response => {
        try {
          // lastError must be consumed inside Safari's callback. Its text may
          // contain paths or native diagnostic data and is never returned.
          finish(response, Boolean(api.runtime.lastError));
        } catch { finish(undefined, true); }
      });
      if (returned && typeof returned.then === "function") {
        returned.then(value => finish(value), () => finish(undefined, true));
      }
    } catch { finish(undefined, true); }
  });
}
