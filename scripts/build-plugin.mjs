#!/usr/bin/env node
// Build a companion plugin package (dev flow).
//
//   node scripts/build-plugin.mjs <plugin-dir> [--backend]
//
// Thin wrapper around plugin-cli/lib/build.mjs, which also backs the
// `companion-plugin` CLI — same build logic, plus zip packaging for
// distribution (see plugin-cli/README.md).
//
// - Bundles <plugin-dir>/src/index.{tsx,ts,jsx,js} into the manifest's
//   frontend entry (default frontend.js) inside the plugin dir.
// - --backend: also runs `cargo build --release` in <plugin-dir>/backend and
//   copies the produced cdylib to the manifest's backend.library name.
// - --out: assemble artifacts into a clean package directory (e.g. the dev
//   plugins/ folder) instead of writing into the source tree.
//
// The bundle resolves react/react-dom from the HOST APP at runtime via the
// @companion/plugin shims — the plugin never bundles its own React.

import { createRequire } from "node:module";
import { existsSync, cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../../plugin-cli/lib/build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const buildBackend = args.includes("--backend");
const outIdx = args.indexOf("--out");
const outDir = outIdx !== -1 ? path.resolve(args[outIdx + 1] ?? "") : null;
const pluginDir = path.resolve(args.find((a) => !a.startsWith("--") && a !== outDir) ?? "");
if (!pluginDir || !existsSync(path.join(pluginDir, "manifest.json"))) {
  console.error("usage: node scripts/build-plugin.mjs <plugin-dir-with-manifest.json> [--backend]");
  process.exit(1);
}

const esbuild = createRequire(import.meta.url)(path.join(repoRoot, "node_modules", "esbuild"));
const sdkDir = path.resolve(repoRoot, "..", "sdk", "js", "@companion", "plugin");

try {
  await buildPlugin({
    pluginDir,
    outDir: outDir ?? pluginDir,
    // Historical behavior of this script: always bundle, error if no src.
    frontend: true,
    backend: buildBackend,
    esbuild,
    sdkDir,
  });
  // Stage any bundled assets (e.g. the voice plugin's ONNX/STT models) so
  // the plugin is self-contained. Without this, assets only exist in the
  // source tree and the packaged plugin can't find them.
  const assetsSrc = path.join(pluginDir, "assets");
  const assetsDst = path.join(outDir ?? pluginDir, "assets");
  if (existsSync(assetsSrc)) {
    cpSync(assetsSrc, assetsDst, { recursive: true });
    console.log(`[plugin] ${path.basename(pluginDir)}: staged assets -> ${path.relative(repoRoot, assetsDst)}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
