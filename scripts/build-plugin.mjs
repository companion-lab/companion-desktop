#!/usr/bin/env node
// Build a companion plugin package (dev flow).
//
//   node scripts/build-plugin.mjs <plugin-dir> [--backend]
//
// Uses the published `companion-cli` npm package for the build logic — the
// same logic that backs `companion-cli build` plus zip packaging for
// distribution (https://github.com/companion-lab/plugin-cli).
//
// - Bundles <plugin-dir>/src/index.{tsx,ts,jsx,js} into the manifest's
//   frontend entry (default frontend.js) inside the plugin dir; bundled
//   assets/ are staged alongside so the plugin is self-contained.
// - --backend: also runs `cargo build --release` in <plugin-dir>/backend and
//   copies the produced cdylib to the manifest's backend.library name.
// - --out: assemble artifacts into a clean package directory (e.g. the dev
//   plugins/ folder) instead of writing into the source tree.
//
// The bundle resolves react/react-dom from the HOST APP at runtime via the
// @companion/plugin shims — the plugin never bundles its own React.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const nodeRequire = createRequire(import.meta.url);
const { buildPlugin } = nodeRequire("companion-cli/lib/build.mjs");
const esbuild = nodeRequire("esbuild");
// SDK shims the frontend bundle aliases react/@companion/plugin through.
// Resolution order: explicit COMPANION_SDK_DIR override, then the local
// sibling checkout (multi-repo dev layout), then the published
// @companion-lab/plugin package (ships index.ts plus the same shim files) —
// that last one is what CI uses, where no sibling sdk/ checkout exists.
const localSdkDir = path.resolve(repoRoot, "..", "sdk", "js", "@companion", "plugin");
const sdkDir =
  process.env.COMPANION_SDK_DIR ??
  (existsSync(path.join(localSdkDir, "index.ts"))
    ? localSdkDir
    // exports "." -> ./index.ts, so dirname() lands on the package root
    : path.dirname(nodeRequire.resolve("@companion-lab/plugin")));

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
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
