import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("The experimental relay requires macOS and Xcode.");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "output/relay");
await mkdir(output, { recursive: true });
const result = spawnSync("xcrun", ["swiftc", "-O", "src/relay/RelayCore.swift", "src/relay/main.swift", "-o", path.join(output, "SafAIRelay")], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const file of ["browser.js", "preview.js", "preview.html"]) await copyFile(path.join(root, "src/relay", file), path.join(output, file));
console.log("Built the experimental local relay. It is not installed into SafAI.");
