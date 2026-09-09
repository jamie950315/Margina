import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

test("native IPC exercises authenticated bounded loopback requests with synthetic sessions", { skip: process.platform !== "darwin", timeout: 90_000 }, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "safai-native-ipc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "NativeIPCFixture");
  const built = spawnSync("xcrun", ["swiftc", "-D", "RELAY_TESTING", "src/relay/RelayCore.swift", "src/relay/RelayLoginPolicy.swift", "src/relay/RelaySessionVault.swift", "src/relay/RelayLoginBroker.swift", "src/native/RelayNativeIPC.swift", "tests/fixtures/relay-native-ipc.swift", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(built.status, 0, built.stderr);
  let probes = 0;
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.cookie, undefined, "synthetic secure session cookies cannot be sent to HTTP");
    assert.equal(request.url, "/api/auth/session");
    probes++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ user: { id: "synthetic-ipc-user" }, accessToken: "synthetic-ipc-access", expires: new Date(Date.now() + 3600_000).toISOString() }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const processes = [];
  t.after(async () => {
    await Promise.all(processes.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }));
  });
  async function launch(mode = "normal") {
    await mkdir(path.join(directory, mode), { recursive: true, mode: 0o700 });
    const descriptorPath = path.join(directory, mode, "native.json");
    const child = spawn(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "src/relay"), descriptorPath, mode], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    processes.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native IPC fixture timed out")), 5000);
      child.stdio[3].once("data", data => { clearTimeout(timer); assert.equal(String(data), "ready\n"); resolve(); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`native IPC fixture exited ${code}`)); });
    });
    assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    assert.equal(descriptor.version, 1);
    assert.match(descriptor.secret, /^[0-9a-f]{64}$/);
    return { ...descriptor, descriptorPath, child, logs: () => stdout + stderr };
  }
  const address = await launch();
  const request = (overrides = {}) => {
    const { method = "POST", target = "/status", headers = {}, omit = [], extra = "", body = "" } = overrides;
    const fields = { Host: `127.0.0.1:${address.port}`, "Content-Length": "0", "X-SafAI-Native": address.secret, ...headers };
    for (const field of omit) delete fields[field];
    return `${method} ${target} HTTP/1.1\r\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}\r\n`).join("")}${extra}\r\n${body}`;
  };
  const raw = (wire, port = address.port) => new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setTimeout(7500, () => { socket.destroy(); reject(new Error("native IPC did not reclaim a request")); });
    socket.on("data", chunk => { data += chunk; });
    socket.on("error", error => { if (error.code !== "ECONNRESET") reject(error); });
    socket.on("close", () => resolve(data));
    socket.on("connect", () => socket.write(wire));
  });
  async function action(target) {
    const response = await raw(request({ target: "/" + target }));
    assert.match(response, /^HTTP\/1\.1 200 OK\r\n/);
    assert.ok(!response.includes(address.secret), "IPC descriptor capability never appears in responses");
    assert.match(response, /Cache-Control: no-store/);
    return JSON.parse(response.split("\r\n\r\n")[1]);
  }
  await t.test("initial state has no provider capability and malformed callers cannot mutate it", async () => {
    assert.equal((await action("status")).state.providerURL, undefined);
    const denied = [
      { omit: ["X-SafAI-Native"] }, { headers: { "X-SafAI-Native": "wrong" } },
      { headers: { Origin: "null" } }, { headers: { Origin: "http://127.0.0.1" } },
      { headers: { Host: `localhost:${address.port}` } }, { omit: ["Host"] },
      { method: "GET" }, { method: "OPTIONS" }, { target: "/arbitrary" },
      { target: "//status" }, { target: "/status?secret=ignored" },
      { target: "http://127.0.0.1/status" }, { headers: { "Content-Length": "1" }, body: "x" },
      { headers: { "Transfer-Encoding": "chunked" } }, { omit: ["Content-Length"] },
      { extra: "x-safai-native: duplicate\r\n" }, { extra: "Host: duplicate\r\n" },
      { extra: " malformed: folded\r\n" }, { extra: "missing-colon\r\n" },
      { body: "x" }, { extra: "Padding: " + "x".repeat(4096) + "\r\n" },
    ];
    for (const item of denied) assert.equal(await raw(request(item)), "");
    assert.equal((await action("status")).state.phase, "signedOut");
    assert.equal(probes, 0);
  });
  await t.test("only a synthetic verified login publishes provider access; logout and switch revoke", async () => {
    assert.equal((await action("login")).accepted, true);
    async function signedIn() {
      for (let index = 0; index < 100; index++) {
        const result = await action("status");
        if (result.state.phase === "signedIn") return result.state;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail("synthetic session was not verified");
    }
    const first = await signedIn();
    assert.ok(first.providerURL);
    assert.ok(probes > 0);
    const beforeReconnect = probes;
    assert.equal((await action("reconnect")).accepted, true);
    const restored = await signedIn();
    assert.ok(restored.providerURL && restored.providerURL !== first.providerURL);
    assert.equal(probes, beforeReconnect + 1, "explicit reconnect rechecks the saved synthetic session exactly once");
    const logout = await action("logout");
    assert.equal(logout.state.phase, "signedOut");
    assert.equal(logout.state.providerURL, undefined);
    assert.equal((await action("switch")).accepted, true);
    const second = await signedIn();
    assert.notEqual(first.providerURL, second.providerURL);
    await action("logout");
    assert.ok(!address.logs().includes(address.secret));
    assert.ok(!address.logs().includes("synthetic-native-ipc-session"));
  });
  await t.test("incomplete clients expire and oversized responses are withheld", async () => {
    const started = Date.now();
    assert.equal(await raw("POST /status HTTP/1.1\r\nHost:"), "");
    assert.ok(Date.now() - started >= 4500);
    assert.equal((await action("status")).state.phase, "signedOut");
    const oversized = await launch("oversized");
    const wire = request({ headers: { Host: `127.0.0.1:${oversized.port}`, "X-SafAI-Native": oversized.secret } });
    assert.equal(await raw(wire, oversized.port), "");
  });
  await t.test("at most sixteen incomplete connections are retained", async () => {
    const held = await Promise.all(Array.from({ length: 16 }, () => new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: address.port });
      socket.once("error", reject);
      socket.once("connect", () => { socket.write("POST /status HTTP/1.1\r\n"); resolve(socket); });
    })));
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await raw(request()), "", "seventeenth simultaneous request must be refused");
    } finally { for (const socket of held) socket.destroy(); }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await action("status")).state.phase, "signedOut");
  });
  await t.test("one group has one broker owner, and orderly stop releases the unchanged lock inode", async () => {
    const lock = path.join(path.dirname(address.descriptorPath), "native.lock");
    const before = await stat(lock);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal(before.size, 0);
    const saved = await readFile(address.descriptorPath, "utf8");
    const contender = spawnSync(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "src/relay"), address.descriptorPath, "normal"], { stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 5000 });
    assert.equal(contender.status, 2, "second process must fail before starting another broker");
    assert.equal(await readFile(address.descriptorPath, "utf8"), saved);
    assert.equal((await action("status")).state.phase, "signedOut");
    const exited = once(address.child, "exit");
    address.child.kill("SIGTERM"); await exited;
    await assert.rejects(readFile(address.descriptorPath), { code: "ENOENT" });
    assert.equal((await stat(lock)).ino, before.ino, "stop must not unlink the lock file");
    const restarted = await launch();
    assert.notEqual(restarted.secret, address.secret);
    assert.equal((await stat(lock)).ino, before.ino);
  });
  await t.test("ownership rejects symlinks, nonempty files and unsafe lock permissions", async () => {
    const fixture = path.join(directory, "invalid-lock");
    await mkdir(fixture, { mode: 0o700 });
    const lock = path.join(fixture, "native.lock");
    const target = path.join(fixture, "target");
    await writeFile(target, "", { mode: 0o600 });
    const refused = () => {
      const result = spawnSync(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "src/relay"), path.join(fixture, "native.json"), "normal"], { stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 5000 });
      assert.equal(result.status, 2);
    };
    await symlink(target, lock); refused();
    await rm(lock);
    await writeFile(lock, "unexpected", { mode: 0o600 }); refused();
    await writeFile(lock, ""); await chmod(lock, 0o644); refused();
    await assert.rejects(readFile(path.join(fixture, "native.json")), { code: "ENOENT" });
  });
});
