import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "dist");
const packageInfo = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(packageInfo.version) || packageInfo.version !== manifest.version ||
    !Number.isSafeInteger(packageInfo.safariBuildNumber) || packageInfo.safariBuildNumber < 2) {
  throw new Error("Safari package versions must match and the build number must advance past the original build.");
}
const projectLocation = path.join(projectRoot, "SafariApp");
const xcodeProject = path.join(
  projectLocation,
  "Margina",
  "Margina.xcodeproj",
  "project.pbxproj",
);

const result = spawnSync(
  "xcrun",
  [
    "safari-web-extension-packager",
    extensionPath,
    "--project-location",
    projectLocation,
    "--app-name",
    "Margina",
    "--bundle-identifier",
    "dev.jamie.safai",
    "--swift",
    "--macos-only",
    "--copy-resources",
    "--no-open",
    "--no-prompt",
    "--force",
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const original = await readFile(xcodeProject, "utf8");
let patched = original
  .replaceAll(
    "PRODUCT_BUNDLE_IDENTIFIER = dev.jamie.Margina;",
    "PRODUCT_BUNDLE_IDENTIFIER = dev.jamie.safai;",
  )
  .replaceAll(
    /MACOSX_DEPLOYMENT_TARGET = [0-9.]+;/g,
    "MACOSX_DEPLOYMENT_TARGET = 12.3;",
  );

if (patched === original) {
  throw new Error("The generated Xcode project no longer matches the expected packager output.");
}

await writeFile(xcodeProject, patched);

// Generated Xcode sources remain disposable. Production native behavior lives in src/.
const nativeRoot = path.join(projectRoot, "src/native");
const relayRoot = path.join(projectRoot, "src/relay");
const appRoot = path.join(projectLocation, "Margina/Margina");
const extensionRoot = path.join(projectLocation, "Margina/Margina Extension");
// Use the authored macOS tile directly; the packager adds its own tile and inset.
const appIcons = path.join(appRoot, "Assets.xcassets/AppIcon.appiconset");
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await copyFile(
      path.join(projectRoot, `src/assets/icon-${size * scale}.png`),
      path.join(appIcons, `mac-icon-${size}@${scale}x.png`),
    );
  }
}
for (const file of ["Main.html", "Style.css", "Script.js"]) {
  const destination = path.join(appRoot, "Resources", ...(file === "Main.html" ? ["Base.lproj", file] : [file]));
  await copyFile(path.join(nativeRoot, "welcome", file), destination);
}
const relaySources = ["RelayLoginPolicy.swift", "RelaySessionVault.swift", "RelayLoginBroker.swift", "RelayLoginWindow.swift", "RelayCore.swift"];
const appSources = await Promise.all(relaySources.map(file => readFile(path.join(relayRoot, file), "utf8")));
appSources.push(await readFile(path.join(nativeRoot, "RelayNativeIPC.swift"), "utf8"));
appSources.push(await readFile(path.join(nativeRoot, "AppDelegate.swift"), "utf8"));
await writeFile(path.join(appRoot, "AppDelegate.swift"), appSources.join("\n\n"));
await writeFile(path.join(extensionRoot, "SafariWebExtensionHandler.swift"),
  await readFile(path.join(nativeRoot, "RelayNativeIPC.swift"), "utf8") + "\n" +
  await readFile(path.join(nativeRoot, "SettingsVault.swift"), "utf8") + "\n" +
  await readFile(path.join(nativeRoot, "SafariWebExtensionHandler.swift"), "utf8"));
const controller = path.join(appRoot, "ViewController.swift");
const controllerSource = await readFile(controller, "utf8");
if (!controllerSource.includes("NSApplication.shared.terminate(nil)")) throw new Error("Generated preferences controller changed unexpectedly.");
await writeFile(controller, controllerSource.replace("NSApplication.shared.terminate(nil)", "// Keep the bundled relay available after opening Safari settings."));

const group = "$(TeamIdentifierPrefix)dev.jamie.safai.shared";
for (const directory of [appRoot, extensionRoot]) {
  const info = path.join(directory, "Info.plist");
  await writeFile(info, (await readFile(info, "utf8")).replace(/<\/dict>\s*<\/plist>\s*$/, `<key>SafAIAppGroup</key><string>${group}</string>\n</dict>\n</plist>\n`));
  const sandbox = directory === extensionRoot ? "<key>com.apple.security.app-sandbox</key><true/><key>com.apple.security.network.client</key><true/>" : "";
  await writeFile(path.join(directory, "Margina.entitlements"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${sandbox}<key>com.apple.security.application-groups</key><array><string>${group}</string></array></dict></plist>\n`);
}
await mkdir(path.join(appRoot, "Relay"), { recursive: true });
for (const file of ["browser.js", "preview.js", "preview.html"]) await copyFile(path.join(relayRoot, file), path.join(appRoot, "Relay", file));

// The packager uses explicit PBX groups/build phases. Add one folder resource;
// all Swift remains behind the two pre-existing source references above.
const fileID = "534146414952454C4159".padEnd(23, "0") + "1";
const buildID = "534146414952454C4159".padEnd(23, "0") + "2";
patched = patched.replace("/* Begin PBXBuildFile section */", `/* Begin PBXBuildFile section */\n\t\t${buildID} /* Relay in Resources */ = {isa = PBXBuildFile; fileRef = ${fileID} /* Relay */; };`)
  .replace("/* Begin PBXFileReference section */", `/* Begin PBXFileReference section */\n\t\t${fileID} /* Relay */ = {isa = PBXFileReference; lastKnownFileType = folder; path = Margina/Relay; sourceTree = SOURCE_ROOT; };`)
  .replace(/(\n\t\t\t\t[^\n]+\/\* Main\.html in Resources \*\/,)/, `$1\n\t\t\t\t${buildID} /* Relay in Resources */,`);
if (!patched.includes(`${buildID} /* Relay in Resources */,`)) throw new Error("Generated app resource phase changed unexpectedly.");
let appConfigurations = 0;
let extensionConfigurations = 0;
patched = patched.replace(/(buildSettings = \{)([\s\S]*?)(\n\t\t\t\};)/g, (whole, opening, settings, closing) => {
  const isExtension = settings.includes("PRODUCT_BUNDLE_IDENTIFIER = dev.jamie.safai.Extension;");
  const isApp = settings.includes("PRODUCT_BUNDLE_IDENTIFIER = dev.jamie.safai;");
  if (!isExtension && !isApp) return whole;
  if (isExtension) extensionConfigurations++; else appConfigurations++;
  settings = settings.replace(/\n\s*SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor;/g, "")
    .replace(/SWIFT_APPROACHABLE_CONCURRENCY = YES;/g, "SWIFT_APPROACHABLE_CONCURRENCY = NO;");
  settings = settings.replace(/CURRENT_PROJECT_VERSION = [^;]+;/, `CURRENT_PROJECT_VERSION = ${packageInfo.safariBuildNumber};`)
    .replace(/MARKETING_VERSION = [^;]+;/, `MARKETING_VERSION = ${packageInfo.version};`);
  if (isApp) settings = settings.replace("ENABLE_APP_SANDBOX = YES;", "ENABLE_APP_SANDBOX = NO;");
  settings += `\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = "${isApp ? "Margina" : "Margina Extension"}/Margina.entitlements";`;
  if (isExtension) settings += '\n\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited) SAFAI_EXTENSION";\n\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;';
  return opening + settings + closing;
});
if (appConfigurations !== 2 || extensionConfigurations !== 2) throw new Error("Expected exactly Debug and Release native configurations.");
await writeFile(xcodeProject, patched);
console.log(`Packaged Safari project at ${path.dirname(xcodeProject)}`);
