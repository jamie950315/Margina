import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const read = name => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("browser and native versions advance together for Safari resource refresh", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("src/manifest.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.ok(pkg.safariBuildNumber > 1);
  const source = await read("scripts/package-safari.mjs");
  assert.match(source, /CURRENT_PROJECT_VERSION = \$\{packageInfo.safariBuildNumber\}/);
  assert.match(source, /MARKETING_VERSION = \$\{packageInfo.version\}/);
});

test("native packaging preserves a self-contained app and private extension bridge", async () => {
  const source = await read("scripts/package-safari.mjs");
  for (const file of ["RelaySessionVault.swift", "RelayNativeIPC.swift", "SettingsVault.swift", "AppDelegate.swift", "SafariWebExtensionHandler.swift"]) assert.ok(source.includes(file), file);
  assert.match(source, /SAFAI_EXTENSION/);
  assert.match(source, /com\.apple\.security\.application-groups/);
  assert.match(source, /com\.apple\.security\.network\.client/);
  assert.match(source, /TeamIdentifierPrefix/);
  assert.match(source, /Relay in Resources/);
  assert.match(source, /Keep the bundled relay available/);
  assert.match(source, /"Localizations\.js"/);
  assert.match(source, /Localizations\.js in Resources/);
  assert.match(source, /CFBundleLocalizations/);
  assert.match(source, /MarginaPreferredLanguages/);
  assert.doesNotMatch(source, /relay-staging/);
  assert.match(await read("scripts/build-relay.mjs"), /src\/relay\/RelaySessionVault\.swift/);
});

test("native messages have no arbitrary routes, logging or private IPC key response", async () => {
  const source = await read("src/native/SafariWebExtensionHandler.swift");
  assert.match(source, /message\.count == 1/);
  assert.match(source, /\["status", "login", "logout", "switch", "reconnect"\]/);
  assert.match(source, /configuration\.activates = false/);
  assert.match(source, /configuration\.allowsRunningApplicationSubstitution = false/);
  assert.match(source, /completionHandler\(nil\)/);
  assert.match(source, /\["phase", "message", "revision", "providerURL", "error"\]/);
  assert.doesNotMatch(source, /os_log|print\(|\.arguments\s*=/);
});

test("native settings messages use a profile-isolated Keychain CAS without waking the app", async () => {
  const handler = await read("src/native/SafariWebExtensionHandler.swift");
  const vault = await read("src/native/SettingsVault.swift");
  assert.match(handler, /settings\.read/);
  assert.match(handler, /settings\.write/);
  assert.match(handler, /SFExtensionProfileKey/);
  assert.match(handler, /SETTINGS_CONFLICT/);
  assert.ok(handler.indexOf('message["action"] as? String == "settings.read"') < handler.indexOf("NSWorkspace.OpenConfiguration"));
  assert.match(vault, /kSecAttrSynchronizable as String: false/);
  assert.match(vault, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(vault, /flock\(descriptor, LOCK_EX\)/);
  assert.match(vault, /O_NOFOLLOW \| O_CLOEXEC/);
  assert.doesNotMatch(vault, /UserDefaults|write\(to:|print\(|os_log/);
});

test("private IPC requires local authenticated empty-body native requests", async () => {
  const source = await read("src/native/RelayNativeIPC.swift");
  assert.match(source, /host: "127\.0\.0\.1"/);
  assert.match(source, /fields\["origin"\] == nil/);
  assert.match(source, /fields\["content-length"\] == "0"/);
  assert.match(source, /fields\["transfer-encoding"\] == nil/);
  assert.match(source, /relayConstantTimeEqual\(fields\["x-safai-native"\]/);
  assert.match(source, /data\.count <= 4096/);
  assert.match(source, /clients\.count < 16/);
  assert.match(source, /0o700/);
  assert.match(source, /0o600/);
  assert.match(source, /O_NOFOLLOW \| O_CLOEXEC/);
  assert.match(source, /flock\(fd, LOCK_EX \| LOCK_NB\)/);
  assert.match(source, /broker\.shutdown\(\)/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin/);
});

test("native app and extension sources typecheck on macOS", { skip: process.platform !== "darwin", timeout: 120000 }, () => {
  const groups = [
    ["-D", "SAFAI_EXTENSION", "src/native/RelayNativeIPC.swift", "src/native/SettingsVault.swift", "src/native/SafariWebExtensionHandler.swift"],
    ["src/relay/RelayLoginPolicy.swift", "src/relay/RelaySessionVault.swift", "src/relay/RelayLoginBroker.swift", "src/relay/RelayLoginWindow.swift", "src/relay/RelayCore.swift", "src/native/RelayNativeIPC.swift", "src/native/AppDelegate.swift"],
  ];
  for (const files of groups) {
    const result = spawnSync("xcrun", ["swiftc", "-typecheck", ...files], { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || String(result.error || "Swift typecheck failed"));
  }
});
