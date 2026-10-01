import { readFile, mkdir, access, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/archive-safari.mjs [--app /path/to/Margina.app]\nVerifies a signed universal build and creates a development-preview ZIP under output/releases.");
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("Safari archives must be verified on macOS.");
if (args.length && (args.length !== 2 || args[0] !== "--app")) throw new Error("Only --app is supported.");
const app = path.resolve(args[1] ?? path.join(root, "output/DerivedDataDistribution/Build/Products/Release/Margina.app"));
if (path.basename(app) !== "Margina.app") throw new Error("Expected the built Margina.app bundle.");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const extension = path.join(app, "Contents/PlugIns/Margina Extension.appex");
const required = ["Contents/MacOS/Margina", "Contents/Resources/Relay/browser.js", "Contents/Resources/Base.lproj/Main.html",
  "Contents/PlugIns/Margina Extension.appex/Contents/MacOS/Margina Extension", "Contents/PlugIns/Margina Extension.appex/Contents/Resources/manifest.json"];
for (const file of required) {
  try { await access(path.join(app, file)); }
  catch { throw new Error("Incomplete app bundle: required native or extension resources are missing."); }
}
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue; // Signed Apple framework links are checked by codesign.
    if (/^(?:\.env(?:\..*)?|native\.json|auth\.json)$|\.(?:keychain(?:-db)?|p12|pfx|pem|mobileprovision)$/i.test(entry.name)) {
      throw new Error("Unexpected private/runtime material found in the app bundle.");
    }
    if (entry.isDirectory()) await inspect(path.join(directory, entry.name));
  }
}
await inspect(app);
function run(command, values) {
  const result = spawnSync(command, values, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} verification failed; no release archive was produced.`);
  return result.stdout;
}
for (const bundle of [app, extension]) {
  const info = path.join(bundle, "Contents/Info.plist");
  const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", info]).trim();
  const build = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", info]).trim();
  if (version !== pkg.version || build !== String(pkg.safariBuildNumber)) throw new Error("Built app version does not match source.");
  run("codesign", ["--verify", "--deep", "--strict", bundle]);
  const entitlements = run("codesign", ["-d", "--entitlements", ":-", bundle]);
  if (/<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(entitlements)) throw new Error("Debugging entitlement is not allowed in the archive.");
  const executable = path.join(bundle, "Contents/MacOS", bundle === app ? "Margina" : "Margina Extension");
  const architectures = run("lipo", ["-archs", executable]).trim().split(/\s+/);
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) throw new Error("Build both Apple silicon and Intel architectures before archiving.");
}
const manifest = JSON.parse(await readFile(path.join(extension, "Contents/Resources/manifest.json"), "utf8"));
if (manifest.version !== pkg.version || !manifest.permissions.includes("nativeMessaging")) throw new Error("The archive must contain the integrated extension.");
const folder = path.join(root, "output/releases");
await mkdir(folder, { recursive: true });
const basename = `Margina-${pkg.version}-build${pkg.safariBuildNumber}-macOS-preview`;
const zip = path.join(folder, `${basename}.zip`);
try { await access(zip); throw new Error("The archive already exists; preserve it or advance the build number before archiving again."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
await writeFile(path.join(folder, `${basename}.sha256`), `${digest}  ${path.basename(zip)}\n`);
console.log(`Created ${zip}\nSHA-256 ${digest}\nDevelopment preview: signature verification is not Apple notarization. Installed Safari end-to-end verification must be reported separately.`);
