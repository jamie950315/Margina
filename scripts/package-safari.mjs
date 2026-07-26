import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "dist");
const projectLocation = path.join(projectRoot, "SafariApp");
const xcodeProject = path.join(
  projectLocation,
  "SafAI",
  "SafAI.xcodeproj",
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
    "SafAI",
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
const patched = original
  .replaceAll(
    "PRODUCT_BUNDLE_IDENTIFIER = dev.jamie.SafAI;",
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
console.log(`Packaged Safari project at ${path.dirname(xcodeProject)}`);
