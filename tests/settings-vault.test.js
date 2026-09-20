import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

test("native settings vault validates CAS and persists a synthetic Keychain item across processes", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "safai-settings-vault-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "SettingsVaultCheck");
  const lock = path.join(directory, "settings.lock");
  const service = `dev.jamie.safai.test.settings.${randomUUID()}`;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = spawnSync("xcrun", ["swiftc", "src/native/SettingsVault.swift", "tests/fixtures/settings-vault.swift", "-framework", "Security", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(build.status, 0, build.stderr);
  const run = action => spawnSync(binary, [action, lock, service], { encoding: "utf8", timeout: 10_000 });
  const memory = run("memory");
  assert.equal(memory.status, 0, memory.stdout + memory.stderr);
  assert.match(memory.stdout, /SETTINGS_VAULT_MEMORY_CHECKS_PASSED/);
  try {
    const write = run("write-real");
    assert.equal(write.status, 0, write.stdout + write.stderr);
    assert.match(write.stdout, /SETTINGS_VAULT_REAL_WRITE_PASSED/);
    const read = run("read-real");
    assert.equal(read.status, 0, read.stdout + read.stderr);
    assert.match(read.stdout, /SETTINGS_VAULT_REAL_READ_PASSED/);
  } finally {
    const cleanup = run("cleanup");
    assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
  }
});
