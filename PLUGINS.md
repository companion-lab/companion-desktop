# Plugins

Companion is a plugin-based application. A plugin is a directory containing a
`manifest.json`, an optional bundled React frontend (`frontend.js`), and an
optional Rust backend (`*.dylib` / `*.dll` / `*.so`). Plugins live in
`{app_data_dir}/plugins/` (user-installed) and, in debug builds, also in
`{repo}/app/plugins/` — a symlink to the repo-root `plugins/` build output
(developer plugins).

## Package layout

```
my-plugin/
  manifest.json            # metadata + entry points
  frontend.js              # bundled ESM (produced by scripts/build-plugin.mjs)
  libmy_backend.dylib      # optional Rust cdylib
  src/
    index.tsx              # plugin author source (React)
  backend/                 # optional Rust crate (crate-type = ["cdylib"])
    Cargo.toml
    src/lib.rs
```

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "abi": 2,
  "permissions": ["storage", "events", "tools"],
  "frontend": { "entry": "frontend.js" },
  "backend": { "library": "libmy_backend.dylib" }
}
```

- `id`: lowercase alphanumeric with `-`/`_`, must not contain `__` (that is the
  tool-name qualifier separator `{id}__{tool}`).
- `abi`: must match the host ABI (`companion-plugin-sdk::ABI_VERSION`,
  currently `2`). Plugins built against an older SDK are refused at load time.
- `permissions`: declarative in v1 (storage, events, tools, …). Enforced for
  storage namespacing and tool routing; other permissions are informational.
- `frontend` / `backend` are both optional: a plugin can be frontend-only,
  backend-only, or both.

## Frontend

Plugin frontends are React bundles activated with a scoped `PluginContext`.
They never bundle React: `react`, `react-dom`, `react/jsx-runtime` are aliased
to the host's copies at build time (see `scripts/build-plugin.mjs`), and the
host injects `globalThis.__companion_host__` before activation.

```tsx
import { definePlugin } from "@companion-lab/plugin";
import { useState } from "react";

export default definePlugin((ctx) => {
  ctx.log.info("activating");
  ctx.settings.registerTab({
    id: "my-tab",
    label: "My Plugin",
    group: "Plugins",
    desc: "Plugin settings",
    component: () => <div>hello {ctx.id}</div>,
  });
  ctx.tools.register({
    name: "ping",
    description: "Ping the plugin",
    inputSchema: { type: "object" },
    execute: async () => "pong",
  });
  // Talk to the Rust backend (if any):
  ctx.backend.call("ping", {}).then(console.log);
});
```

### Extension points (`ctx`)

- `settings.registerTab(tab)` / `overrideTab(id, component)` — add or replace
  a settings tab. Tab bodies are assembled from sections (see below) unless
  `component` is given.
- `settings.registerSection({ id, tabId, slot: "top" | "bottom", order?, component })`
  — insert a section into an existing tab. Plugin "top" contributions default to
  order 50 (render above the core sections, which sit at 100); "bottom" defaults
  to 150 (below).
- `settings.replaceSection(id, component)` — replace a section by its stable
  id. Core ids still owned by the host: `general.windowSize`,
  `motion.idleMixer`, `performance.performance`,
  `plugins.plugins`. Feature-owned ids (`general.chatbox`, `general.persona`,
  `general.voiceInput`, `tts.settings`, `stt.settings`,
  `connection.api`, `connection.speech`, `alarms.alarms`, `calendar.calendar`,
  `model.models`, `motion.motions`, `motion.emotions`, `tools.mcp`) belong to
  their plugins and are replaceable the same way while installed. Sections a
  plugin registers only render while that plugin is enabled — e.g. the chat
  plugin owns the General tab's Chat Box (show/hide) and Persona sections and
  the stt plugin its Voice Input section (microphone shortcut + voice
  interrupt), so they appear and disappear with their plugin.
- `main.registerWidget({ slot: "main.top" | "main.bottom" | "main.overlay", order?, component })`
  — add a widget to the avatar window. Overlay widgets must position themselves
  (e.g. `position: fixed`).
- `main.overrideWidget("chatPanel" | "alarmBanner" | "errorOverlay", component)` —
  replace a built-in widget. The override receives the same props as the
  built-in.
- `main.registerContextMenuItem({ id, label, icon?, danger?, order?, onSelect })`.
- `tools.register(tool)` — a frontend-executed tool the avatar's model can call.
  Qualified name becomes `{pluginId}__{name}`.
- `backend.call(method, payload)` — calls the plugin's Rust backend (if any).
- `events.on(event, cb)` / `events.emit(event, payload)` — namespaced as
  `plugin:{id}:{event}`.
- `storage.get/set/remove(key)` — namespaced key/value storage in app data.
- `avatar` — live avatar control: `setEmotion`, `triggerMotion`, `setViseme`,
  `registerMotion`, `registerEmotion`, `loadModel({id}|{base64})`,
  `describeCapabilities()`. No-ops outside the main window.
- `services` — capability provider registry: `registerTts(provider)` /
  `registerStt(provider)` publish engines (the bundled tts and stt plugins do);
  `tts()` returns the active TTS provider (silent fallback when the tts plugin is
  uninstalled), `stt()` returns the active STT provider or `null`.
- `secrets.set/get/remove(name)` — OS keychain namespaced to the plugin
  (`{pluginId}:{name}` accounts).
- `ui` — the host's UI kit (`Button`, `TextInput`, `SectionCard`, …) so
  plugins match the app design.
- `useSettingsState()` (from `@companion-lab/plugin`) — read/write the real
  settings-page state from inside a settings tab/section.

## Rust backend

A backend is a `cdylib` crate depending on `companion-plugin-sdk` and
exporting the ABI via `export_plugin!`:

```rust
use companion_plugin_sdk::{export_plugin, Plugin, PluginCtx, ToolDef};
use serde_json::{json, Value};

struct MyBackend;

impl Plugin for MyBackend {
    fn init(&mut self, ctx: PluginCtx) -> Result<(), String> {
        // Writable per-plugin dir; created by the host before init:
        // {app_data}/plugins-data/{id}/
        let data_dir = ctx.data_dir().ok_or("no data dir")?;
        // Read-only package dir (manifest, bundles, bundled assets/):
        let _package_dir = ctx.plugin_dir();
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        ctx.info("ready");
        Ok(())
    }
    fn handle(&mut self, method: &str, payload: Value) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!({ "pong": true })),
            "tool" => {
                // chat-model tool calls arrive here with
                // {"name": "...", "args": {...}}.
                let name = payload["name"].as_str().unwrap_or_default();
                match name {
                    "my_tool" => Ok(json!("done")),
                    _ => Err(format!("unknown tool: {name}")),
                }
            }
            _ => Err(format!("unknown method: {method}")),
        }
    }
    fn tools(&mut self) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "my_tool".into(),
            description: "Does the thing".into(),
            input_schema: json!({ "type": "object" }),
        }]
    }
}

export_plugin!(MyBackend::new());
```

### ABI safety

- The host checks `companion_plugin_abi_version` before calling anything and
  refuses to load plugins built against a different ABI.
- Every call into the dylib is wrapped in `catch_unwind`; a panicking
  backend degrades to "every call errors" instead of crashing the app.
- `tools()` is queried live on every `plugin_list_tools`, so dynamic tool
  sets (e.g. an MCP plugin whose servers connect over time) stay current.
  Keep it fast: read a cache, never block on I/O.
- Backends are **never unloaded** while the app runs (safe `dlclose` of Rust
  dylibs is not supported). Disabling a plugin stops routing calls to it;
  fully unloading needs an app restart.

## Build & install

```bash
# Frontend only:
node app/scripts/build-plugin.mjs examples/notes-plugin --out plugins/notes

# Frontend + Rust backend:
node app/scripts/build-plugin.mjs examples/notes-plugin --backend --out plugins/notes
```

The script bundles `src/index.{tsx,ts,jsx,js}` into the manifest's frontend
entry, and (with `--backend`) runs `cargo build --release` in `backend/` and
copies the cdylib into the package.

## Bundled feature plugins

The seven built-in features (alarms, calendar, chat, mcp, stt, tts, vrm) ship
as plugin packages in the app resources (`resources/plugins/`) and are seeded
into `{app_data}/plugins/` on first run. Uninstalling one tombstones the id
(`plugins-removed.json`) so it stays gone across restarts; **Plugins →
"Restore bundled features"** clears tombstones and reinstalls. Their sources
live in the repo under `features/` — build them all with
`features/build-all.sh [--backend] [--out <dir>]`.

Plugin stylesheets cannot be loaded as separate files (the host imports only
the JS bundle) — inline them and inject a `<style>` tag on first render, like
the alarms plugin's `banner-styles.ts`.

### Package as a distributable zip

`plugin-cli/` provides the `companion-cli` CLI, which runs the same build
(esbuild frontend + cargo backend) and zips the result for import via
Settings → Plugins → Import plugin…:

```bash
companion-cli init my-plugin
companion-cli build my-plugin
# -> my-plugin/dist/my-plugin-0.1.0.zip
```

Install it globally with `npm install -g companion-cli`, or run it straight
from the repo with `node plugin-cli/bin/companion-cli.mjs …`. Options:
`--out <dir>` (default
`./dist`), `--name <file>` (default `<id>-<version>.zip`), `--flat` (manifest
at the zip root instead of an `<id>/` folder — the importer accepts both),
`--no-backend`, `--no-frontend`, `--sdk <dir>`. The zip contains only
`manifest.json`, the bundled frontend entry, and the backend library — sources
and build junk never ship. See `plugin-cli/README.md`.

Dev plugins are discovered in `{repo}/app/plugins/` (a symlink to the
repo-root `plugins/` staging dir); user plugins in
`{app_data_dir}/plugins/`. The example `notes` plugin ships as a reference
implementation covering all extension points.

## Permissions (v1)

| Permission | Meaning |
|---|---|
| `storage` | Use `ctx.storage` (always scoped to the plugin's own key/value file). |
| `events`  | Emit/listen on namespaced events. |
| `tools`   | Contribute chat tools (frontend and/or backend). |

The declared list is shown in the Settings → Plugins tab. Storage namespacing
and tool routing are enforced; other permissions are informational in v1.
