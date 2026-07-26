import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBridgeUrl,
  createBridgeToken,
  extensionOrigin,
  isValidBridgeConnectEvent,
  readBridgeToken,
} from "../src/core/bridge.js";

test("createBridgeToken produces an unguessable hex token", () => {
  const cryptoObject = {
    getRandomValues(buffer) {
      buffer.set(Array.from({ length: buffer.length }, (_, index) => index + 1));
      return buffer;
    },
  };

  assert.equal(createBridgeToken(cryptoObject), "0102030405060708090a0b0c0d0e0f10");
});

test("buildBridgeUrl keeps the unguessable token inside the URL fragment", () => {
  const url = buildBridgeUrl("safari-web-extension://abc/panel.html?demo=1", "secret-token");

  assert.equal(url, "safari-web-extension://abc/panel.html?demo=1#bridge=secret-token");
  assert.equal(readBridgeToken(url), "secret-token");
});

test("extensionOrigin preserves a Safari extension origin even when URL.origin is null", () => {
  assert.equal(
    extensionOrigin("safari-web-extension://abc/panel.html"),
    "safari-web-extension://abc",
  );
  assert.equal(extensionOrigin("https://example.com/panel.html"), "https://example.com");
});

test("isValidBridgeConnectEvent accepts only the parent with the matching token and port", () => {
  const parentWindow = {};
  const port = {};
  const valid = {
    source: parentWindow,
    data: { type: "SAFAI_BRIDGE_CONNECT", token: "secret-token" },
    ports: [port],
  };

  assert.equal(isValidBridgeConnectEvent(valid, parentWindow, "secret-token"), true);
  assert.equal(
    isValidBridgeConnectEvent({ ...valid, data: { ...valid.data, token: "forged" } }, parentWindow, "secret-token"),
    false,
  );
  assert.equal(isValidBridgeConnectEvent({ ...valid, source: {} }, parentWindow, "secret-token"), false);
  assert.equal(isValidBridgeConnectEvent({ ...valid, ports: [] }, parentWindow, "secret-token"), false);
});
