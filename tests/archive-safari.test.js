import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

test("archive command documents its signed universal preview scope", () => {
  const result = spawnSync(process.execPath, ["scripts/archive-safari.mjs", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /signed universal/);
  assert.match(result.stdout, /development-preview/);
});

test("archive refuses incomplete bundles and arbitrary output paths", { skip: process.platform !== "darwin" }, () => {
  for (const args of [["--app", "/nonexistent/Margina.app"], ["--output", "/tmp/unrequested.zip"]]) {
    const result = spawnSync(process.execPath, ["scripts/archive-safari.mjs", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incomplete app bundle|Only --app/);
  }
});

test("archive verification requires native resources, signatures, version alignment and no debug entitlement", async () => {
  const source = await readFile(new URL("../scripts/archive-safari.mjs", import.meta.url), "utf8");
  assert.match(source, /Resources\/Relay\/browser\.js/);
  assert.match(source, /--verify", "--deep", "--strict/);
  assert.match(source, /get-task-allow/);
  assert.match(source, /safariBuildNumber/);
  assert.match(source, /architectures\.includes\("arm64"\)/);
  assert.match(source, /architectures\.includes\("x86_64"\)/);
  assert.match(source, /already exists/);
  assert.match(source, /nativeMessaging/);
});
