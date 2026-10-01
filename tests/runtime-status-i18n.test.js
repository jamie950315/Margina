import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t } from "../src/i18n/index.js";

test("fixed native status translations respect the sidebar language override", async () => {
  const source = await readFile(new URL("../src/relay/RelayLoginPolicy.swift", import.meta.url), "utf8");
  const keys = ["signedOut", "restoring", "opening", "waitingForUser", "checking", "signedIn", "blocked",
    "signedInPersistent", "relayStoppedSaved", "logoutFailed", "restoreFailed", "refreshFailed", "saveFailed", "savedLoginUnconfirmed"];
  const languages = ["en", "zh-Hant", "zh-Hans", "ja"];
  const catalogs = {};
  for (const language of languages) {
    const section = source.split(`"${language}": [`)[1].split("\n        ],")[0];
    catalogs[language] = Object.fromEntries(keys.map(key => {
      const value = new RegExp(`"${key}":\\s*("(?:\\\\.|[^"\\\\])*")`, "u").exec(section)?.[1];
      assert.ok(value, `${language}.${key} must exist`);
      return [key, JSON.parse(value)];
    }));
  }
  for (const key of keys) {
    for (const input of languages) {
      for (const override of languages) {
        assert.equal(t(catalogs[input][key], [], override), catalogs[override][key], `${input} -> ${override}: ${key}`);
      }
    }
  }
  assert.equal(t("A user's account label remains unchanged", [], "ja"), "A user's account label remains unchanged");
});
