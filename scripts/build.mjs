import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const outputRoot = path.join(projectRoot, "dist");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "assets"), { recursive: true });
await mkdir(path.join(outputRoot, "assets", "katex"), { recursive: true });

const manifestSource = await readFile(path.join(sourceRoot, "manifest.json"), "utf8");
JSON.parse(manifestSource);

await Promise.all([
  cp(path.join(sourceRoot, "manifest.json"), path.join(outputRoot, "manifest.json")),
  cp(path.join(sourceRoot, "panel", "panel.html"), path.join(outputRoot, "panel.html")),
  cp(path.join(sourceRoot, "panel", "panel.css"), path.join(outputRoot, "panel.css")),
  cp(path.join(sourceRoot, "assets"), path.join(outputRoot, "assets"), { recursive: true }),
  cp(
    path.join(projectRoot, "node_modules", "katex", "dist", "katex.min.css"),
    path.join(outputRoot, "assets", "katex", "katex.min.css"),
  ),
  cp(
    path.join(projectRoot, "node_modules", "katex", "dist", "fonts"),
    path.join(outputRoot, "assets", "katex", "fonts"),
    { recursive: true },
  ),
]);

const common = {
  bundle: true,
  target: ["safari15.4"],
  legalComments: "none",
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(sourceRoot, "background", "index.js")],
    outfile: path.join(outputRoot, "background.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(sourceRoot, "content", "index.js")],
    outfile: path.join(outputRoot, "content-script.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [path.join(sourceRoot, "panel", "index.js")],
    outfile: path.join(outputRoot, "panel.js"),
    format: "iife",
    minify: true,
  }),
]);

console.log(`Built Safari Web Extension at ${outputRoot}`);
