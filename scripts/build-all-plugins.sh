#!/usr/bin/env bash
# Build every bundled feature plugin into a target directory.
#
#   scripts/build-all-plugins.sh [--backend] [--out <dir>] [--plugins-dir <dir>]
#
# App-repo copy of plugin-repos/build-all.sh (that one lives outside any git
# repo, so CI can't run it). Builds the default feature plugins per platform
# via scripts/build-plugin.mjs. l2d is intentionally NOT in the feature list:
# the bundled set is exactly the ids in src-tauri BUNDLED_IDS, which excludes
# it.
#
# Default output: repo-root plugins/ (dev discovery dir, staged into the app
# bundle by src-tauri/build.rs). Release packaging passes
# --out src-tauri/resources/plugins directly, which makes build.rs a no-op.
#
# Also ensures per-platform build prerequisites:
#   - npm deps of each plugin repo (frontends resolve e.g. three from there)
#   - stt: moonshine speech models (shipped as package assets) and, with
#     --backend, the moonshine native link lib for the host platform
#   - tts: Supertonic ONNX models (shipped as package assets)
#
# Plugin sources resolve from, in order:
#   $COMPANION_PLUGIN_REPOS
#   <repo>/plugin-repos        (CI: plugin repos cloned next to the app)
#   <repo>/../plugin-repos     (local multi-repo dev layout)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

backend_flag=""
out_dir="$repo_root/plugins"
plugins_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend) backend_flag="--backend"; shift ;;
    --out) out_dir="$(mkdir -p "$2" 2>/dev/null; cd "$2" && pwd)"; shift 2 ;;
    --plugins-dir) plugins_dir="$(cd "$2" && pwd)"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$plugins_dir" ]]; then
  if [[ -n "${COMPANION_PLUGIN_REPOS:-}" ]]; then
    plugins_dir="$COMPANION_PLUGIN_REPOS"
  elif [[ -d "$repo_root/plugin-repos" ]]; then
    plugins_dir="$repo_root/plugin-repos"
  else
    plugins_dir="$repo_root/../plugin-repos"
  fi
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  for cand in \
    "$HOME/Library/Application Support/Herd/config/nvm/versions/node"/v*/bin \
    "$HOME/.nvm/versions/node"/v*/bin; do
    if [[ -x "$cand/node" ]]; then
      export PATH="$cand:$PATH"
      break
    fi
  done
fi

# Host platform for the stt moonshine native lib (same mapping as
# moonshine-sys/build.rs, which panics on anything else — notably there is no
# macos-x86_64 prebuilt, so macOS builds are arm64-only).
target_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$target_os" in
  darwin) platform_dir="macos-arm64" ;;
  linux)  platform_dir="linux-x86_64" ;;
  mingw*|msys*|cygwin*) platform_dir="windows-x86_64" ;;
  *) platform_dir="" ;;
esac

features=(
  alarms
  calendar
  chat
  mcp
  stt
  tts
  vrm
)

status=0
for feature in "${features[@]}"; do
  dir="$plugins_dir/companion-plugin-$feature"
  if [[ ! -f "$dir/manifest.json" ]]; then
    echo "[build-all] skip $feature (no manifest in $dir)"
    continue
  fi
  # Features without a backend crate must not force --backend (it would fail
  # the build); compute the per-feature flag BEFORE any use of it.
  if [[ -n "$backend_flag" && ! -d "$dir/backend" ]]; then
    backend_flag_tmp=""
  else
    backend_flag_tmp="$backend_flag"
  fi

  # Plugin frontends resolve their own npm deps (e.g. vrm's three) from the
  # repo dir — esbuild only aliases react/@companion to the host SDK shims.
  if [[ -f "$dir/package.json" && ! -d "$dir/node_modules" ]]; then
    echo "[build-all] installing npm deps for $feature"
    (cd "$dir" && pnpm install --silent) \
      || echo "[build-all] pnpm install failed for $feature (continuing)" >&2
  fi

  if [[ "$feature" == "stt" ]]; then
    # Speech models ship inside the package's assets/.
    if [[ ! -f "$dir/assets/moonshine/stt/tokenizer.bin" ]]; then
      echo "[build-all] downloading stt speech models"
      (cd "$dir" && bash scripts/download-moonshine-models.sh) \
        || echo "[build-all] download-moonshine-models.sh failed (continuing)" >&2
    fi
    if [[ -n "$backend_flag_tmp" && -n "$platform_dir" && ! -d "$dir/moonshine-sys/lib/$platform_dir" ]]; then
      echo "[build-all] downloading moonshine native lib for $platform_dir"
      (cd "$dir/moonshine-sys/scripts" && bash download-lib.sh) \
        || echo "[build-all] download-lib.sh failed (continuing)" >&2
    fi
  fi

  if [[ "$feature" == "tts" && ! -f "$dir/assets/supertonic/onnx/vocoder.onnx" ]]; then
    echo "[build-all] downloading supertonic tts models"
    (cd "$dir" && bash scripts/download-models.sh) \
      || echo "[build-all] download-models.sh failed (continuing)" >&2
  fi

  echo "[build-all] building $feature -> $out_dir/$feature"
  if ! node "$repo_root/scripts/build-plugin.mjs" "$dir" $backend_flag_tmp --out "$out_dir/$feature"; then
    echo "[build-all] FAILED: $feature" >&2
    echo "::error::[build-all] plugin '$feature' failed to build (see the log above this line)"
    status=1
  fi
done

exit $status
