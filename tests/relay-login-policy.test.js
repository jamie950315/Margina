import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native official-login policy validates navigation, owned sessions and cancellation", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "safai-login-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "PolicyCheck");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = spawnSync("xcrun", ["swiftc", "src/relay/RelayLoginPolicy.swift", "tests/fixtures/relay-login-policy.swift", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(build.status, 0, build.stderr);
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /LOGIN_POLICY_CHECKS_PASSED/);
});
