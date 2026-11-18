#!/usr/bin/env node
// Sync macOS permission plists with what the built plugin packages declare.
//
//   node scripts/merge-plugin-permissions.mjs <plugins-dir>
//
// Scans <plugins-dir>/*/manifest.json and appends each package's
// macOS-relevant permissions ("microphone", "camera") to the app's
// src-tauri plists:
//
// - Entitlements.plist: hardened-runtime entitlements, so `tauri build`
//   codesigns with the rights the bundled backends need (mic input, camera).
// - Info.plist: TCC usage descriptions, so macOS can show the prompts.
//
// Idempotent: keys already present are left untouched, so hand-written
// entries (and their comments) survive. Re-run after every build-all.
//
// Note "screen" needs no plist entry: macOS screen recording is TCC-gated
// without an Info.plist usage key or a hardened-runtime entitlement.
// "storage"/"events"/"tools"/"secrets" are host-side only, no plist impact.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pluginsDir = path.resolve(process.argv[2] ?? path.join(repoRoot, "plugins"));
if (!existsSync(pluginsDir)) {
  console.error(`[merge-permissions] no plugins dir: ${pluginsDir}`);
  process.exit(1);
}

// permission -> entitlements (hardened runtime) and Info.plist TCC keys.
const ENTITLEMENTS = {
  microphone: [
    // audio-input is the real restricted entitlement; device.microphone is
    // what the hand-maintained plist historically carried alongside it.
    "com.apple.security.device.audio-input",
    "com.apple.security.device.microphone",
  ],
  camera: ["com.apple.security.device.camera"],
};
const INFO_USAGE = {
  microphone: ["NSMicrophoneUsageDescription"],
  camera: ["NSCameraUsageDescription"],
};
const USAGE_TEXT = {
  NSMicrophoneUsageDescription: "Companion uses the microphone for local speech recognition.",
  NSCameraUsageDescription:
    "Companion uses the camera so the avatar can see you when asked (Vision plugin).",
};

const permissions = new Set();
for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(pluginsDir, entry.name, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const perm of manifest.permissions ?? []) permissions.add(perm);
}

const declared = [...permissions];
const entitlementKeys = declared.flatMap((p) => ENTITLEMENTS[p] ?? []);
const usageKeys = declared.flatMap((p) => INFO_USAGE[p] ?? []);
if (entitlementKeys.length === 0 && usageKeys.length === 0) {
  console.log("[merge-permissions] no macOS-relevant permissions declared — nothing to sync");
  process.exit(0);
}

// Insert "\t<key>…</key>\n\t<value…/>\n" before the root dict's closing tag.
// Textual append (not plutil/PlistBuddy) so existing comments survive.
function mergePlist(file, entries) {
  let text = readFileSync(file, "utf8");
  const added = [];
  for (const [key, valueXml] of entries) {
    if (text.includes(`<key>${key}</key>`)) continue;
    const insert = `\t<key>${key}</key>\n\t${valueXml}\n`;
    const close = text.lastIndexOf("</dict>");
    if (close === -1) {
      console.error(`[merge-permissions] malformed plist (no </dict>): ${file}`);
      process.exit(1);
    }
    text = text.slice(0, close) + insert + text.slice(close);
    added.push(key);
  }
  if (added.length > 0) writeFileSync(file, text);
  return added;
}

const entitlementsFile = path.join(repoRoot, "src-tauri", "Entitlements.plist");
const infoFile = path.join(repoRoot, "src-tauri", "Info.plist");

const addedEntitlements = mergePlist(
  entitlementsFile,
  entitlementKeys.map((key) => [key, "<true/>"]),
);
const addedUsage = mergePlist(
  infoFile,
  usageKeys.map((key) => [key, `<string>${USAGE_TEXT[key]}</string>`]),
);

if (addedEntitlements.length === 0 && addedUsage.length === 0) {
  console.log("[merge-permissions] plists already in sync");
} else {
  if (addedEntitlements.length > 0) {
    console.log(`[merge-permissions] Entitlements.plist + ${addedEntitlements.join(", ")}`);
  }
  if (addedUsage.length > 0) {
    console.log(`[merge-permissions] Info.plist + ${addedUsage.join(", ")}`);
  }
}
