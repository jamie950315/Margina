import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("native local relay preserves security boundaries and real HTTP behavior", { skip: process.platform !== "darwin", timeout: 90_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "safai-relay-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const binary = path.join(temporary, "SafAIRelay");
  const build = spawnSync("xcrun", ["swiftc", "-D", "RELAY_TESTING", "src/relay/RelayLoginPolicy.swift", "src/relay/RelaySessionVault.swift", "src/relay/RelayLoginBroker.swift", "src/relay/RelayCore.swift", "src/relay/main.swift", "-o", binary], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, build.stderr);

  const received = [];
  const upstream = createServer(async (req, res) => {
    const body = [];
    for await (const part of req) body.push(part);
    received.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(body) });
    if (req.url === "/large") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.alloc(24 * 1024 * 1024, 5));
    } else if (req.url === "/cdn/assets/fixture-123.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml ; charset=utf-8" }); res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>fixture()</script></svg>');
    } else if (req.url === "/cdn/assets/bad-html-123.js") {
      res.writeHead(200, { "Content-Type": "text/html" }); res.end("<script>not a module</script>");
    } else if (req.url === "/cdn/assets/bad-redirect-123.js") {
      res.writeHead(302, { Location: "/next" }); res.end();
    } else if (req.url === "/challenge") {
      res.writeHead(403, { "Content-Type": "text/html", "cf-mitigated": "challenge" });
      res.end("<h1>Do not run challenge scripts</h1>");
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/next?query=1" }); res.end();
    } else if (req.url === "/foreign-redirect") {
      res.writeHead(302, { Location: "https://unapproved.invalid/path" }); res.end();
    } else if (req.url === "/cookie") {
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "test_session=synthetic; HttpOnly; Path=/" }); res.end("{}");
    } else if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: last\n\n"), 300);
    } else if (req.url === "/echo") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(Buffer.concat(body));
    } else if (req.url.startsWith("/cdn/assets/")) {
      res.writeHead(200, { "Content-Type": "text/javascript" }); res.end("export const fixture = true;");
    } else {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'nonce-fixture'; frame-ancestors 'none'; object-src 'none'; report-uri https://report.invalid/",
        "X-Frame-Options": "DENY",
        "Set-Cookie": "private_session=fixture; HttpOnly; Path=/",
      });
      res.end('<!doctype html><html><head><title>Upstream fixture</title><script nonce="fixture" src="/cdn/assets/fixture-123.js"></script></head><body>Real upstream content</body></html>');
    }
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const child = spawn(binary, ["--test-origin", upstreamOrigin, "--resources", path.join(root, "src/relay")], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGTERM"); });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const deadline = setTimeout(() => reject(new Error("relay startup timeout")), 10_000);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(deadline); resolve(JSON.parse(output.split("\n")[0])); }
    });
    child.on("error", reject);
    child.on("exit", code => { if (!output) reject(new Error(`relay exited ${code}`)); });
  });
  assert.deepEqual(Object.keys(address).sort(), ["host", "port"], "startup must not log session credentials");
  assert.match(address.host, /^safai-control-[a-f0-9-]{36}\.localhost$/);
  const controlOrigin = `http://${address.host}:${address.port}`;
  const preview = await fetch(`${controlOrigin}/__safai/`);
  assert.equal(preview.headers.get("content-security-policy").includes("frame-ancestors 'none'"), true);
  const html = await preview.text();
  assert.ok(!/[a-f0-9]{64}/.test(html), "unauthorized HTTP HTML must not contain capabilities");
  const launch = await new Promise(resolve => {
    let raw = "";
    child.stdio[3].on("data", chunk => { raw += chunk; if (raw.includes("\n")) resolve(JSON.parse(raw.split("\n")[0]).launchURL); });
  });
  const bootstrap = new URLSearchParams(new URL(launch).hash.slice(1)).get("bootstrap");
  const bootResponse = await fetch(`${controlOrigin}/__safai/bootstrap`, { method: "POST", headers: { Origin: controlOrigin, "X-SafAI-Bootstrap": bootstrap } });
  assert.equal(bootResponse.status, 200);
  const { controlKey } = await bootResponse.json();
  assert.equal((await fetch(`${controlOrigin}/__safai/bootstrap`, { method: "POST", headers: { Origin: controlOrigin, "X-SafAI-Bootstrap": bootstrap } })).status, 401, "native bootstrap can only be used once");
  const initialState = await (await fetch(`${controlOrigin}/__safai/status`, { headers: { "X-SafAI-Control": controlKey } })).json();
  const target = new URL(initialState.providerURL);
  const key = target.searchParams.get("__safai_key");
  const origin = target.origin;
  assert.notEqual(origin, controlOrigin);
  assert.notEqual(key, controlKey);
  const authorized = (p, options = {}) => fetch(`${origin}${p}`, { ...options, headers: { "X-SafAI-Relay": key, ...options.headers } });

  await t.test("unauthorized, cross-origin and DNS-rebinding requests never reach upstream", async () => {
    const before = received.length;
    assert.equal((await fetch(`${origin}/`)).status, 401);
    assert.equal((await fetch(`${origin}/?__safai_key=incorrect`)).status, 401);
    assert.equal((await authorized("/", { headers: { Origin: "https://unapproved.invalid" } })).status, 403);
    assert.equal((await fetch(`${origin}/__safai/`, { headers: { "Sec-Fetch-Dest": "iframe" } })).status, 403);
    const badHost = await new Promise(resolve => {
      const req = request(origin, { headers: { Host: "attacker.invalid" } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
    });
    assert.equal(badHost, 403);
    assert.equal(received.length, before);
  });
  await t.test("rejects unauthorized uploads before reading their bodies", async () => {
    const status = await new Promise((resolve, reject) => {
      const req = request(origin, { method: "POST", headers: { "Content-Length": String(32 * 1024 * 1024) } }, res => { res.resume(); resolve(res.statusCode); req.destroy(); });
      req.on("error", reject);
      req.setTimeout(1000, () => { req.destroy(); reject(new Error("authorization happened after body buffering")); });
      req.flushHeaders();
    });
    assert.equal(status, 401);
  });
  await t.test("removes framing restrictions without discarding script protection", async () => {
    const response = await authorized("/");
    assert.equal(response.status, 200);
    const policy = response.headers.get("content-security-policy");
    assert.ok(policy.includes("script-src 'self' 'nonce-fixture'"));
    assert.ok(policy.includes("object-src 'none'"));
    assert.ok(!policy.includes("frame-ancestors"));
    assert.ok(!policy.includes("report-uri"));
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const body = await response.text();
    assert.ok(body.includes("Real upstream content"));
    assert.ok(body.indexOf("/__safai/bridge.js") < body.indexOf("/cdn/assets/fixture"));
    assert.ok(body.includes('nonce="fixture"'));
    assert.ok(!body.includes(controlKey), "provider document never receives the native control capability");
  });
  await t.test("capabilities and unrelated localhost cookies never leave the relay", async () => {
    const response = await fetch(`${origin}/next?query=1&__safai_key=${key}`, { headers: { Cookie: "unrelated_local_secret=do-not-forward", Referer: `${origin}/?__safai_key=${key}` } });
    await response.text();
    const last = received.at(-1);
    assert.equal(last.url, "/next?query=1");
    assert.equal(last.headers["x-safai-relay"], undefined);
    assert.equal(last.headers.cookie?.includes("unrelated_local_secret"), false);
    assert.ok(!JSON.stringify(last.headers).includes(key));
  });
  await t.test("native session cookies stay in memory and are not exposed locally", async () => {
    const response = await authorized("/cookie");
    assert.equal(response.headers.get("set-cookie"), null);
    await response.text();
    await (await authorized("/next")).text();
    assert.ok(received.at(-1).headers.cookie.includes("test_session=synthetic"));
  });
  await t.test("redirects remain local and unapproved targets fail closed", async () => {
    const response = await authorized("/redirect", { redirect: "manual" });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location"));
    assert.equal(target.origin, origin);
    assert.equal(target.pathname, "/next");
    assert.equal(target.searchParams.get("__safai_key"), key);
    assert.equal((await authorized("/foreign-redirect", { redirect: "manual" })).status, 502);
    assert.equal((await authorized("/__safai/upstream/unapproved.invalid/")).status, 403);
  });
  await t.test("provider challenges surface without running or pretending to solve them", async () => {
    const response = await authorized("/challenge");
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(body.includes("需要瀏覽器驗證"));
    assert.ok(!body.includes("Do not run challenge scripts"));
  });
  await t.test("binary request bodies survive a real round trip", async () => {
    const body = Buffer.from([0, 255, 13, 10, 128, 1]);
    const response = await authorized("/echo", { method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream" }, body });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  });
  await t.test("streaming reaches the browser before upstream completion", async () => {
    const response = await authorized("/stream");
    const reader = response.body.getReader();
    const first = await reader.read();
    const text = Buffer.from(first.value).toString();
    assert.ok(text.includes("data: first"));
    assert.ok(!text.includes("data: last"));
    let rest = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += Buffer.from(chunk.value); }
    assert.ok(rest.includes("data: last"));
  });
  await t.test("stalled response readers are disconnected instead of holding a relay slot", async () => {
    const bytes = await new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(origin).port), "127.0.0.1");
      let count = 0;
      const deadline = setTimeout(() => { socket.destroy(); reject(new Error("stalled relay writer did not expire")); }, 5000);
      socket.on("connect", () => {
        socket.pause();
        socket.write(`GET /large HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nX-SafAI-Relay: ${key}\r\n\r\n`);
        setTimeout(() => socket.resume(), 1800);
      });
      socket.on("data", chunk => { count += chunk.length; });
      socket.on("error", error => { if (error.code !== "ECONNRESET") { clearTimeout(deadline); reject(error); } });
      socket.on("close", () => { clearTimeout(deadline); resolve(count); });
    });
    assert.ok(bytes < 24 * 1024 * 1024, "test must exercise an incomplete stalled response");
    assert.equal((await authorized("/next")).status, 200, "relay remains usable after reclaiming the connection");
  });
  await t.test("only narrowly identified static modules bypass capability checks", async () => {
    assert.equal((await fetch(`${origin}/cdn/assets/fixture-123.js`)).status, 200);
    assert.equal((await fetch(`${origin}/backend-api/private.js`)).status, 401);
    assert.equal((await fetch(`${origin}/cdn/assets/../private.js`)).status, 401);
    const badHTML = await fetch(`${origin}/cdn/assets/bad-html-123.js`);
    assert.equal(badHTML.status, 502);
    assert.ok(!(await badHTML.text()).includes(key));
    const redirect = await fetch(`${origin}/cdn/assets/bad-redirect-123.js`, { redirect: "manual" });
    assert.equal(redirect.status, 502);
    assert.equal(redirect.headers.get("location"), null, "public assets must not mint private document capabilities");
    const svg = await fetch(`${origin}/cdn/assets/fixture-123.svg`);
    assert.equal(svg.status, 200);
    assert.ok(svg.headers.get("content-security-policy").includes("sandbox"), "SVG cannot execute as a privileged local document, including legal MIME whitespace");
    assert.equal((await authorized("/__safai/upstream/auth.openai.com/")).status, 501, "account entry stays disabled until separate-origin isolation is implemented");
    const source = await readFile(path.join(root, "src/relay/browser.js"), "utf8");
    assert.ok(!source.includes("document.cookie"), "bridge must not export provider cookies");
  });
  await t.test("native login controls are isolated from the provider origin and rotate old capabilities", async () => {
    const control = (p, options = {}) => fetch(`${controlOrigin}${p}`, { ...options, headers: { "X-SafAI-Control": controlKey, ...options.headers } });
    assert.equal((await authorized("/__safai/")).status, 403);
    assert.equal((await authorized("/__safai/login/start", { method: "POST", headers: { "X-SafAI-Control": controlKey, Origin: origin } })).status, 403);
    assert.equal((await control("/__safai/login/start", { method: "POST" })).status, 403, "missing Origin is not a native command");
    assert.equal((await control("/__safai/login/start", { method: "POST", headers: { Origin: "null" } })).status, 403);
    assert.equal((await control("/__safai/login/start", { method: "POST", headers: { Origin: origin } })).status, 403);
    assert.equal((await control("/__safai/login/start", { method: "POST", headers: { Origin: controlOrigin, "X-SafAI-Control": key } })).status, 401);
    assert.equal((await control("/__safai/login/start", { method: "POST", headers: { Origin: controlOrigin }, body: "must not accept credentials" })).status, 400);
    assert.equal((await control("/echo")).status, 404, "control server is not a provider proxy");
    const started = await control("/__safai/login/start", { method: "POST", headers: { Origin: controlOrigin } });
    assert.equal(started.status, 202);
    assert.equal((await control("/__safai/login/start", { method: "POST", headers: { Origin: controlOrigin } })).status, 409);
    assert.equal((await authorized("/next")).status, 401, "old provider capability is revoked before account entry");
    const waiting = await (await control("/__safai/status")).json();
    assert.equal(waiting.providerURL, undefined, "candidate session is not published");
    const cancelled = await (await control("/__safai/login/cancel", { method: "POST", headers: { Origin: controlOrigin } })).json();
    assert.equal(cancelled.phase, "signedOut");
    const next = new URL(cancelled.providerURL);
    assert.notEqual(next.searchParams.get("__safai_key"), key);
    assert.equal((await fetch(next)).status, 200);
  });
});
