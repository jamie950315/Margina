import test from "node:test";
import assert from "node:assert/strict";

import * as settingsModule from "../src/core/settings.js";

const {
  DEFAULT_SETTINGS,
  mergeSettings,
  providerConfigurationChanged,
  SettingsMutationCoordinator,
} = settingsModule;

test("mergeSettings fills defaults for a first-time user", () => {
  assert.deepEqual(mergeSettings({}), DEFAULT_SETTINGS);
});

test("mergeSettings keeps valid saved choices", () => {
  assert.deepEqual(
    mergeSettings({
      mode: "chatgpt",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      model: "llama",
      includePage: false,
      includeSelection: false,
      stream: false,
    }),
    {
      mode: "chatgpt",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local",
      model: "llama",
      includePage: false,
      includeSelection: false,
      stream: false,
    },
  );
});

test("mergeSettings rejects malformed saved values without losing safe strings", () => {
  const settings = mergeSettings({
    mode: "unknown",
    baseUrl: 12,
    apiKey: "saved-key",
    includePage: "no",
  });

  assert.equal(settings.mode, DEFAULT_SETTINGS.mode);
  assert.equal(settings.baseUrl, DEFAULT_SETTINGS.baseUrl);
  assert.equal(settings.apiKey, "saved-key");
  assert.equal(settings.includePage, DEFAULT_SETTINGS.includePage);
});

test("SettingsMutationCoordinator keeps a pending settings write exclusive", () => {
  assert.equal(typeof SettingsMutationCoordinator, "function");
  const coordinator = new SettingsMutationCoordinator();
  const modeChange = coordinator.begin("mode", {
    ...DEFAULT_SETTINGS,
    mode: "chatgpt",
  });

  assert.ok(modeChange);
  assert.equal(coordinator.kind, "mode");
  assert.equal(
    coordinator.begin("toggle", { ...DEFAULT_SETTINGS, includePage: false }),
    null,
  );
  assert.equal(
    coordinator.begin("save", { ...DEFAULT_SETTINGS, model: "replacement" }),
    null,
  );

  coordinator.end(modeChange);
  assert.equal(coordinator.kind, null);
  assert.ok(coordinator.begin("toggle", { ...DEFAULT_SETTINGS, includePage: false }));
});

test("providerConfigurationChanged distinguishes API paths but ignores stream display", () => {
  const previous = {
    ...DEFAULT_SETTINGS,
    baseUrl: "https://gateway.example/team-a/v1",
  };
  assert.equal(
    providerConfigurationChanged(previous, {
      ...previous,
      baseUrl: "https://gateway.example/team-b/v1",
    }),
    true,
  );
  assert.equal(
    providerConfigurationChanged(previous, { ...previous, stream: !previous.stream }),
    false,
  );
  assert.equal(
    providerConfigurationChanged(previous, { ...previous, model: "another-model" }),
    true,
  );
});
