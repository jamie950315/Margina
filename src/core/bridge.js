import { t } from "../i18n/index.js";
export function createBridgeToken(cryptoObject = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildBridgeUrl(panelUrl, token) {
  const url = new URL(panelUrl);
  url.hash = new URLSearchParams({ bridge: token }).toString();
  return url.toString();
}

export function extensionOrigin(url) {
  const parsed = new URL(url);
  if (parsed.origin !== "null") return parsed.origin;
  if (!parsed.protocol || !parsed.host) throw new TypeError(t("無效的擴充功能網址"));
  return `${parsed.protocol}//${parsed.host}`;
}

export function readBridgeToken(url = globalThis.location.href) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("bridge") ?? "";
}

export function isValidBridgeConnectEvent(event, parentWindow, expectedToken) {
  return Boolean(
    expectedToken &&
      event?.source === parentWindow &&
      event?.data?.type === "SAFAI_BRIDGE_CONNECT" &&
      event?.data?.token === expectedToken &&
      event?.ports?.[0],
  );
}
