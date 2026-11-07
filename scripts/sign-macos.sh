#!/usr/bin/env bash
# Ad-hoc sign the macOS bundle with a STABLE identifier + mic entitlements.
#
# Why: without bundle signing, the executable keeps its linker ad-hoc
# signature whose identifier is unique per link (companion-<hash>). TCC then
# keys mic records to a dead identifier on every rebuild: the app reads
# Denied forever while System Settings shows a stale toggle that matches
# nothing. Signing the BUNDLE with identifier = CFBundleIdentifier makes the
# ad-hoc designated requirement `identifier "dev.fl.companion"` stable, so a
# granted mic permission survives rebuilds.
#
#   app/scripts/sign-macos.sh [path/to/companion.app]
#
# `tauri build` also runs codesign since bundle.macOS.signingIdentity = "-";
# this script is the fallback/repair for bundles produced before that change.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="${1:-$root/src-tauri/target/release/bundle/macos/companion.app}"

[[ -d "$app" ]] || { echo "no bundle at $app" >&2; exit 1; }

# --options runtime: codesign enables hardened runtime implicitly for the
# restricted mic entitlements anyway; request it explicitly so the flag is
# deterministic. The entitlements file carries
# com.apple.security.cs.disable-library-validation — required, or the
# hardened app refuses to dlopen the linker-signed plugin backends.
codesign --force --deep --sign - --options runtime \
  --identifier dev.fl.companion \
  --entitlements "$root/src-tauri/Entitlements.plist" \
  "$app"

codesign --verify --deep --strict "$app"
echo "signed: $app (identifier dev.fl.companion, mic entitlement)"
