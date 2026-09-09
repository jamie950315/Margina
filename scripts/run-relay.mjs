import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const binary = fileURLToPath(new URL("../output/relay/SafAIRelay", import.meta.url));
const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
let ready = false;
createInterface({ input: child.stdout }).on("line", (line) => {
  if (ready) return;
  try {
    const { port } = JSON.parse(line);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    ready = true;
    console.log(`Local relay preview: http://127.0.0.1:${port}/__safai/`);
    console.log("Experimental: do not enter credentials or private content. Ctrl+C stops the relay and discards its session.");
  } catch { /* Never print unexpected native output, which could contain upstream data. */ }
});
child.stderr.on("data", () => console.error("Native relay reported an error; no provider data was logged."));
child.on("error", () => { console.error("Could not start the relay. Run npm run build:relay first."); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill("SIGTERM"));
