import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("native login publishes only independently verified sessions and rejects stale completions", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "safai-login-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "LoginFixture");
  const built = spawnSync("xcrun", ["swiftc", "src/relay/RelayCore.swift", "src/relay/RelayLoginPolicy.swift", "src/relay/RelayLoginBroker.swift", "tests/fixtures/relay-login-server.swift", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(built.status, 0, built.stderr);
  let mode = "valid";
  let held;
  let escaped = false;
  const credentials = [];
  const session = () => JSON.stringify({ user: { id: "synthetic-test-user" }, accessToken: "synthetic-test-access", expires: new Date(Date.now() + 3600_000).toISOString() });
  const upstream = createServer((req, res) => {
    if (req.url === "/api/auth/session") {
      credentials.push(req.headers.cookie);
      if (mode === "hold") { held = res; return; }
      if (mode === "redirect") { res.writeHead(302, { Location: "/must-not-follow" }); res.end(); return; }
      if (mode === "challenge") { res.writeHead(403, { "Content-Type": "application/json", "cf-mitigated": "challenge" }); res.end(session()); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mode === "oversized") res.end(" ".repeat(513 * 1024));
      else if (mode === "expired") res.end(JSON.stringify({ user: { id: "synthetic" }, accessToken: "synthetic", expires: "2000-01-01T00:00:00Z" }));
      else if (mode === "anonymous") res.end("{}");
      else res.end(session());
    } else { if (req.url === "/must-not-follow") escaped = true; res.end("fixture"); }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const child = spawn(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "src/relay")], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  const readLine = input => new Promise((resolve, reject) => {
    let raw = "";
    const deadline = setTimeout(() => reject(new Error("native fixture startup timed out")), 5000);
    input.on("data", chunk => { raw += chunk; if (raw.includes("\n")) { clearTimeout(deadline); resolve(JSON.parse(raw.split("\n")[0])); } });
  });
  const [address, { launchURL }] = await Promise.all([readLine(child.stdout), readLine(child.stdio[3])]);
  const origin = `http://${address.host}:${address.port}`;
  const secret = new URLSearchParams(new URL(launchURL).hash.slice(1)).get("bootstrap");
  const { controlKey } = await (await fetch(`${origin}/__safai/bootstrap`, { method: "POST", headers: { Origin: origin, "X-SafAI-Bootstrap": secret } })).json();
  const control = (endpoint, method = "GET") => fetch(`${origin}/__safai/${endpoint}`, { method, headers: { Origin: origin, "X-SafAI-Control": controlKey } });
  const status = async () => (await control("status")).json();
  const settled = async expected => {
    for (let index = 0; index < 100; index++) {
      const value = await status();
      if (value.phase === expected) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`native login did not reach ${expected}`);
  };
  const original = await status();
  assert.equal((await control("login/start", "POST")).status, 202);
  const signedIn = await settled("signedIn");
  assert.ok(signedIn.providerURL && signedIn.providerURL !== original.providerURL);
  assert.equal((await fetch(original.providerURL)).status, 401);
  for (const rejected of ["anonymous", "expired", "redirect", "oversized", "challenge"]) {
    await control("login/cancel", "POST");
    mode = rejected;
    await control("login/start", "POST");
    const denied = await settled("blocked");
    assert.equal(denied.providerURL, undefined, `${rejected} must not publish a candidate session`);
  }
  assert.equal(escaped, false, "session verification must not follow redirects");
  assert.ok(credentials.every(value => value === undefined), "secure ChatGPT fixture credentials cannot leak to an HTTP fixture origin");
  await control("login/cancel", "POST");
  mode = "hold";
  await control("login/start", "POST");
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held);
  await control("login/cancel", "POST");
  mode = "valid";
  await control("login/start", "POST");
  const fresh = await settled("signedIn");
  held.writeHead(200, { "Content-Type": "application/json" }); held.end(session());
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterLateResponse = await status();
  assert.equal(afterLateResponse.phase, "signedIn");
  assert.ok(afterLateResponse.providerURL === fresh.providerURL, "an older response cannot replace a newer session");
});
