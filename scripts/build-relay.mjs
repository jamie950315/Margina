import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("The experimental relay requires macOS and Xcode.");
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--staging")) throw new Error("Only --staging is supported.");
const output = path.join(root, args.includes("--staging") ? "output/relay-staging" : "output/relay");
const app = path.join(output, "SafAI Relay.app");
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(resources, { recursive: true });
const result = spawnSync("xcrun", ["swiftc", "-O", "src/relay/RelayLoginPolicy.swift", "src/relay/RelayLoginBroker.swift", "src/relay/RelayLoginWindow.swift", "src/relay/RelayCore.swift", "src/relay/main.swift", "-o", path.join(contents, "MacOS/SafAIRelay")], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const file of ["browser.js", "preview.js", "preview.html"]) await copyFile(path.join(root, "src/relay", file), path.join(resources, file));
await copyFile(path.join(root, "src/relay/Info.plist"), path.join(contents, "Info.plist"));
if (process.env.SAFAI_SIGN_IDENTITY) {
  const signed = spawnSync("codesign", ["--force", "--sign", process.env.SAFAI_SIGN_IDENTITY, app], { stdio: "inherit" });
  if (signed.status !== 0) process.exit(signed.status ?? 1);
}
console.log("Built the experimental local relay. It is not installed into SafAI.");
