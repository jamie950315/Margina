import test from "node:test";
import assert from "node:assert/strict";

import {
  endpointOriginPattern,
  removeEndpointPermission,
  requestEndpointPermission,
  requestEndpointPermissionWithPriorState,
} from "../src/core/permissions.js";

test("endpointOriginPattern requests only the configured endpoint origin", () => {
  assert.equal(
    endpointOriginPattern("https://provider.example/custom/v1"),
    "https://provider.example/*",
  );
  assert.equal(
    endpointOriginPattern("http://127.0.0.1:11434/v1"),
    "http://127.0.0.1:11434/*",
  );
});

test("requestEndpointPermission keeps an existing Safari permission when request returns no value", async () => {
  const calls = [];
  let resolveContains;
  const browserApi = {
    permissions: {
      contains(options) {
        calls.push(["contains", options]);
        return new Promise((resolve) => {
          resolveContains = resolve;
        });
      },
      request(options) {
        calls.push(["request", options]);
        return Promise.resolve(undefined);
      },
    },
  };

  const permissionPromise = requestEndpointPermission(browserApi, "https://provider.example/v1");

  const descriptor = { origins: ["https://provider.example/*"] };
  assert.deepEqual(calls, [
    ["contains", descriptor],
    ["request", descriptor],
  ]);
  resolveContains(true);
  assert.equal(await permissionPromise, true);
});

test("requestEndpointPermission rejects an absent permission when Safari returns no value", async () => {
  const browserApi = {
    permissions: {
      contains: () => Promise.resolve(false),
      request: () => Promise.resolve(undefined),
    },
  };

  assert.equal(
    await requestEndpointPermission(browserApi, "https://provider.example/v1"),
    false,
  );
});

test("removeEndpointPermission releases a provider origin that is no longer used", async () => {
  let removed;
  const browserApi = {
    permissions: {
      remove(options) {
        removed = options;
        return Promise.resolve(true);
      },
    },
  };

  await removeEndpointPermission(browserApi, "https://old.example/v1");

  assert.deepEqual(removed, { origins: ["https://old.example/*"] });
});

test("requestEndpointPermissionWithPriorState starts the gesture-bound request without awaiting contains", async () => {
  const calls = [];
  let resolveContains;
  const browserApi = {
    permissions: {
      contains() {
        calls.push("contains");
        return new Promise((resolve) => {
          resolveContains = resolve;
        });
      },
      request() {
        calls.push("request");
        return Promise.resolve(true);
      },
    },
  };

  const resultPromise = requestEndpointPermissionWithPriorState(
    browserApi,
    "https://provider.example/v1",
  );
  assert.deepEqual(calls, ["contains", "request"]);
  resolveContains(false);
  assert.deepEqual(await resultPromise, { allowed: true, wasPresent: false });
});

test("requestEndpointPermissionWithPriorState accepts a permission Safari already granted", async () => {
  const browserApi = {
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(undefined),
    },
  };

  assert.deepEqual(
    await requestEndpointPermissionWithPriorState(
      browserApi,
      "https://provider.example/v1",
    ),
    { allowed: true, wasPresent: true },
  );
});

test("permission operations never assume success when extension APIs are missing", async () => {
  await assert.rejects(requestEndpointPermission({}, "https://provider.example/v1"));
  await assert.rejects(requestEndpointPermissionWithPriorState({}, "https://provider.example/v1"));
  await assert.rejects(async () => removeEndpointPermission({}, "https://provider.example/v1"));
});

test("requestEndpointPermission reports permission-state read failures", async () => {
  const failure = new Error("Permission storage failed");
  const browserApi = { permissions: {
    contains: async () => { throw failure; },
    request: async () => true,
  } };
  await assert.rejects(requestEndpointPermission(browserApi, "https://provider.example/v1"),
    (error) => error === failure);
});
