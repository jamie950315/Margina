import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native session vault validates records and fails closed without touching the Keychain", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "safai-session-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "VaultCheck");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = spawnSync("xcrun", ["swiftc", "src/relay/RelayLoginPolicy.swift", "src/relay/RelaySessionVault.swift", "tests/fixtures/relay-session-vault.swift", "-framework", "Security", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(build.status, 0, build.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /SESSION_VAULT_CHECKS_PASSED/);
});
