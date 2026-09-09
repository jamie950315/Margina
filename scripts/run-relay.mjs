import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const binary = fileURLToPath(new URL("../output/relay/SafAI Relay.app/Contents/MacOS/SafAIRelay", import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--open-login")) throw new Error("Only --open-login is supported.");
const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (ready) {
      if (message.event === "officialLoginPageVisible") console.log("The official HTTPS page is visible in the SafAI login window; user input is required.");
      if (message.event === "anonymousIdleExit") console.log("The unused anonymous relay exited after inactivity; no confirmed login was discarded.");
      if (message.event === "loginStateChanged") {
        const states = {
          signedIn: "The native relay independently confirmed the isolated login. Conversation and attachment support are not verified.",
          blocked: "The isolated login check was blocked. No candidate session was published or automatically retried.",
          signedOut: "The local login state was cleared. Existing Safari accounts were not changed.",
        };
        if (Object.hasOwn(states, message.phase)) console.log(states[message.phase]);
      }
      return;
    }
    const { port, host } = message;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^safai-control-[a-f0-9-]{36}\.localhost$/.test(host)) return;
    ready = true;
    console.log(`Local control page (native authorization required): http://${host}:${port}/__safai/`);
    console.log("Experimental: enter credentials only in the official HTTPS login window. Ctrl+C stops the relay and discards its session.");
  } catch { /* Never print unexpected native output, which could contain upstream data. */ }
});
child.stderr.on("data", () => console.error("Native framework diagnostic received; provider data was not logged."));
child.on("error", () => { console.error("Could not start the relay. Run npm run build:relay first."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill("SIGTERM"));
