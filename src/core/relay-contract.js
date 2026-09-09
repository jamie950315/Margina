// Capabilities remain session-local: never store or forward this result to a page.
const phases = new Set(["signedOut", "opening", "waitingForUser", "checking", "restoring", "signedIn", "blocked"]);
export const RELAY_ACTIONS = new Set(["status", "login", "logout", "switch", "reconnect"]);

export function relayProviderURL(value) {
  if (typeof value !== "string" || value.length > 512) throw new Error("ChatGPT 連線網址無效");
  let url;
  try { url = new URL(value); } catch { throw new Error("ChatGPT 連線網址無效"); }
  const host = /^safai-provider-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.localhost$/;
  if (url.protocol !== "http:" || !host.test(url.hostname) || !url.port || Number(url.port) < 1 ||
      url.username || url.password || url.pathname !== "/" || url.hash ||
      !/^\?__safai_key=[a-f0-9]{64}$/.test(url.search) || url.href !== value) {
    throw new Error("ChatGPT 連線網址無效");
  }
  return url;
}

export function relayState(value) {
  if (!value || value.ok !== true || !phases.has(value.phase) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.message !== "string" || value.message.length > 1024) {
    throw new Error("無法確認 ChatGPT 登入狀態");
  }
  const result = { ok: true, phase: value.phase, message: value.message, revision: value.revision };
  if (value.phase === "signedIn") result.providerURL = relayProviderURL(value.providerURL).href;
  else if (value.providerURL !== undefined) throw new Error("未登入的 ChatGPT 不應提供連線網址");
  return result;
}
