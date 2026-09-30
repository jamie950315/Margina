import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("persistent native broker restores, revokes and never saves stale or unverified sessions", { skip: process.platform !== "darwin", timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(tmpdir(), "safai-persistence-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "PersistenceFixture");
  const built = spawnSync("xcrun", ["swiftc", "-D", "RELAY_TESTING", "src/relay/RelayCore.swift", "src/relay/RelayLoginPolicy.swift", "src/relay/RelaySessionVault.swift", "src/relay/RelayLoginBroker.swift", "tests/fixtures/relay-persistence-server.swift", "-o", binary], { cwd: root, encoding: "utf8", timeout: 45_000 });
  assert.equal(built.status, 0, built.stderr);
  let hold = false;
  let valid = true;
  let held;
  let probes = 0;
  const upstream = createServer((req, res) => {
    if (req.url !== "/api/auth/session") { res.end("synthetic page"); return; }
    probes += 1;
    assert.equal(req.headers.cookie, undefined, "secure fixture cookies must not reach HTTP");
    const respond = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(valid ? { user: { id: "synthetic-user" }, accessToken: "synthetic-access", expires: new Date(Date.now() + 3600_000).toISOString() } : {}));
    };
    if (hold) held = respond; else respond();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  async function launch() {
    const child = spawn(binary, [`http://127.0.0.1:${upstream.address().port}`, path.join(root, "src/relay")], { stdio: ["pipe", "ignore", "pipe", "pipe"] });
    t.after(() => child.kill("SIGTERM"));
    let next = 0;
    const waiting = new Map();
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    let raw = "";
    child.stdio[3].on("data", chunk => {
      raw += chunk;
      while (raw.includes("\n")) {
        const end = raw.indexOf("\n"), value = JSON.parse(raw.slice(0, end)); raw = raw.slice(end + 1);
        if (value.ready) ready();
        else { waiting.get(value.id)?.(value); waiting.delete(value.id); }
      }
    });
    await started;
    const command = (action, extra = {}) => new Promise(resolve => {
      const id = ++next; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ id, action, ...extra }) + "\n");
    });
    const settled = async phase => {
      for (let i = 0; i < 100; i++) {
        const value = await command("status"); if (value.state.phase === phase) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`did not reach ${phase}`);
    };
    return { command, settled, child };
  }
  hold = true;
  const first = await launch();
  const restoring = await first.command("status");
  assert.equal(restoring.state.phase, "restoring");
  assert.equal(restoring.state.providerURL, undefined);
  assert.equal(restoring.saves, 0);
  assert.equal(restoring.idleTimerActive, false, "restoration is ineligible for idle exit and needs no idle timer");
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held);
  const revoked = await first.command("logout");
  assert.equal(revoked.state.phase, "signedOut");
  assert.equal(revoked.saved, false);
  assert.equal(revoked.idleTimerActive, true, "logout re-enables anonymous idle reclamation");
  held(); hold = false;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await first.command("status")).saves, 0, "late restore cannot repersist logout");
  await first.command("login");
  const loggedIn = await first.settled("signedIn");
  assert.ok(loggedIn.state.providerURL);
  assert.equal(loggedIn.saves, 1);
  assert.equal(loggedIn.loads, 1);
  assert.equal(loggedIn.idleTimerActive, false, "a confirmed account must not wake for anonymous idle checks");
  const failedClear = await first.command("logout", { clearFails: true });
  assert.equal(failedClear.accepted, false);
  assert.equal(failedClear.state.phase, "blocked");
  assert.equal(failedClear.state.error, true);
  assert.equal(failedClear.state.providerURL, undefined);
  assert.equal(failedClear.idleTimerActive, false, "a blocked account cannot exit automatically");
  assert.equal((await fetch(loggedIn.state.providerURL)).status, 401);
  await first.command("logout", { clearFails: false });
  await first.command("login", { saveFails: true });
  const failedSave = await first.settled("blocked");
  assert.equal(failedSave.saved, false);
  assert.equal(failedSave.state.providerURL, undefined);
  await first.command("login", { saveFails: false });
  const fresh = await first.settled("signedIn");
  await first.command("switch");
  const switched = await first.settled("signedIn");
  assert.notEqual(switched.state.providerURL, fresh.state.providerURL);
  assert.ok(switched.clears >= 3);

  const second = await launch();
  const restored = await second.settled("signedIn");
  assert.equal(restored.loads, 1);
  assert.equal(restored.saves, 1, "restored account is revalidated and saved before publishing");
  const missingSaved = await second.command("reconnect", { forgetSaved: true });
  assert.equal(missingSaved.state.phase, "signedOut");
  assert.equal(missingSaved.idleTimerActive, true, "reconnect without a saved record restores anonymous idle reclamation");
  valid = false;
  const third = await launch();
  const blocked = await third.settled("blocked");
  assert.equal(blocked.saves, 0);
  assert.equal(blocked.saved, true, "failed probe is not mistaken for proven expiry");
  assert.equal(blocked.state.providerURL, undefined);
  const probesBeforePolling = probes;
  await third.command("status");
  await third.command("status");
  assert.equal(probes, probesBeforePolling, "status polling never retries a failed restoration");
  valid = true;
  hold = true;
  held = undefined;
  const reconnecting = await third.command("reconnect");
  assert.equal(reconnecting.accepted, true);
  assert.equal(reconnecting.state.phase, "restoring");
  assert.equal(reconnecting.state.providerURL, undefined);
  assert.equal(reconnecting.idleTimerActive, false);
  const duplicateReconnect = await third.command("reconnect");
  assert.equal(duplicateReconnect.accepted, false, "an active probe cannot be duplicated");
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held);
  held(); hold = false;
  const recovered = await third.settled("signedIn");
  assert.equal(recovered.loads, 2);
  assert.equal(recovered.saves, 1);
  assert.equal(recovered.clears, 0, "reconnect does not erase the saved login");
  assert.ok(recovered.state.providerURL);

  // A logout during an explicit reconnect still invalidates the restore ticket.
  hold = true;
  held = undefined;
  await third.command("reconnect");
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held);
  await third.command("logout");
  held(); hold = false;
  await new Promise(resolve => setTimeout(resolve, 50));
  const afterReconnectLogout = await third.command("status");
  assert.equal(afterReconnectLogout.state.phase, "signedOut");
  assert.equal(afterReconnectLogout.saved, false);
  assert.equal(afterReconnectLogout.saves, 1, "late reconnect cannot restore or save a logged-out account");

  hold = true;
  held = undefined;
  const fourth = await launch();
  for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(held);
  const shutdown = await fourth.command("shutdown");
  assert.equal(shutdown.state.stopped, true);
  assert.equal(shutdown.state.providerURL, undefined);
  assert.equal(shutdown.saved, true, "shutdown must retain the existing saved account");
  assert.equal(shutdown.clears, 0);
  assert.equal(shutdown.saves, 0);
  assert.equal(shutdown.idleTimerActive, false);
  held(); hold = false;
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const action of ["status", "login", "logout", "switch", "reconnect", "refresh"]) {
    const retired = await fourth.command(action);
    assert.equal(retired.accepted, false, `stopped broker rejects ${action}`);
    assert.equal(retired.state.stopped, true);
    assert.equal(retired.saved, true);
    assert.equal(retired.saves, 0, "late probe/refresh cannot save after shutdown");
    assert.equal(retired.clears, 0);
  }
  const liveBeforeShutdown = await first.command("status");
  assert.ok(liveBeforeShutdown.state.providerURL);
  await first.command("shutdown");
  await assert.rejects(fetch(liveBeforeShutdown.state.providerURL), "shutdown closes the old listener");
  assert.ok(probes >= 6);
});
