# companion

puts a 3D VRM avatar on your desktop that acts as the visual body of your AI agent. It sits as a transparent overlay — no window chrome, no background — just your character floating on screen.

The character is connected to an OpenAI-compatible AI provider. When the AI speaks, the mouth moves. When it's happy, it smiles. When you ask it to do something, it can nod, shake its head, or play a motion clip you imported.

```
┌──────────────────────────┐
│                          │
│   Your Desktop           │
│                          │
│              ┌────────┐  │
│              │  VRM   │  │    ← Transparent overlay, resizable
│              │ Avatar │  │    ← Expression + motion in real-time
│              │  (◕‿◕) │  │
│              └────────┘  │
│                          │
│   [Browser] [IDE] [Term] │
└──────────────────────────┘
```

## Features

The app is a small core (window shell, plugin system, settings shell) plus seven
**bundled feature plugins** that ship pre-installed and can be removed in
**Settings → Plugins** — uninstall any feature you don't need, restore it any
time with the **Restore bundled features** button.

| Plugin       | Description                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 💬 Chat      | Streaming chat panel, 3 providers (OpenAI-compatible, Anthropic, Gemini), tool loop, wake word                                                   |
| 🗣️ TTS       | On-device TTS (Supertonic-3) + cloud synthesis, viseme lip sync (Speech Synthesis plugin)                                                        |
| 🎙️ STT       | On-device recognition (Moonshine) + cloud transcription, wake word (Speech Recognition plugin)                                                   |
| ⏰ Alarms    | Alarm tools + background scheduler + ringing banner with snooze                                                                                  |
| 📅 Calendar  | Dated/repeating events, birthday reminders, month/agenda views                                                                                   |
| 🔌 MCP Tools | Model tool-calling over stdio / streamable-HTTP MCP servers                                                                                      |
| 🎭 VRM (vrm) | Avatar engine (Three.js scene, expression, lip sync, idle mixer), custom `.vrm` models, `.vrma` motion clips, emotion presets, graphics settings |

Core (not removable): the transparent window shell, the plugin system itself
(discovery, dylib backends, frontend loading), the settings window, the
avatar-bus seam plugins drive the avatar through, push-to-talk hotkey
plumbing, performance config, and OS keychain access.

```bash
# Rebuild all bundled feature plugins after editing their sources
# in plugin-repos/:
scripts/build-all-plugins.sh --backend
```

See [PLUGINS.md](PLUGINS.md) for the plugin authoring guide (manifest,
frontend contributions, Rust backends, the avatar/services surfaces).

## Making the Avatar Act

The provider returns a motion and an expression with every reply. You can request them directly:

- "do a nod" → plays the built-in `nod`
- "do the reading loop motion" → plays a clip you imported (e.g. `Reading_Loop.vrma`)
- "look angry" → sets the `angry` expression

Motion names come from three built-ins plus every clip you import, and the model is told the full list on every request — so custom clip names work as soon as they're imported. If nothing matches, it returns `none` and says so in text rather than inventing a name.

Expressions behave the same way and accept both built-in names and your own imported presets.

Reply text can also carry inline `<<motion:name>>` / `<<emotion:name>>` tags for providers that answer in plain prose instead of calling the structured tool. Tags are stripped before the text is spoken.

## Alarms

Alarms are exposed to the model as tools, so you can create and manage them by talking:

- "set an alarm for 7am" / "remind me every weekday at 9" / "remind me in 10 minutes"
- "list all my alarms" — answered in plain language, never raw ids
- "pause that alarm" / "delete it"

A background scheduler fires them, and one-shot alarms retire after firing. Alarms persist to disk and are editable in Settings → Alarms.

## MCP Tool Servers

Point it at any MCP server over stdio or streamable HTTP and the model gets those tools. Playwright works out of the box for browser tasks. Servers are added in Settings → MCP and can be toggled individually.

Tools are only offered when a message plausibly needs them, and there's a keyword fallback for models that describe an action in text instead of emitting a tool call.

## Setup

```bash
# 1. Clone the bundled plugin sources into plugin-repos/ (the build script
#    resolves plugin sources from there — the same step CI does)
mkdir -p plugin-repos
for plugin in alarms calendar chat mcp stt tts vrm; do
  git clone --depth 1 \
    "https://github.com/companion-lab/companion-plugin-${plugin}.git" \
    "plugin-repos/companion-plugin-${plugin}"
done

# 2. Build the bundled plugins. Installs each plugin's npm deps, downloads
#    the speech models + native lib (~500 MB), and builds frontends and
#    backends into src-tauri/resources/plugins (where the app loads them).
scripts/build-all-plugins.sh --backend --out src-tauri/resources/plugins

# 3. Install app dependencies and run
pnpm install
pnpm tauri dev
```

If you keep the plugin sources somewhere else, point the
`COMPANION_PLUGIN_REPOS` environment variable at that directory instead.

### Models & assets

| What                                      | Fetched by                                       | License                    |
| ----------------------------------------- | ------------------------------------------------ | -------------------------- |
| Supertonic-3 TTS weights                  | the tts plugin's download script (Setup step 2)  | OpenRAIL-M (Supertone)     |
| Moonshine `medium-streaming-en` STT model | the stt plugin's download script (Setup step 2)  | MIT (Moonshine AI)         |
| Moonshine prebuilt native library         | the stt plugin's download script (`--backend`)   | MIT (Moonshine AI)         |
| Default avatar model                      | bundled with the vrm plugin package              | VRoid Hub uploader's terms |

Model weights are never committed; the scripts fetch them into gitignored
paths. Attribution and full license texts live in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Testing

```bash
pnpm test                          # frontend tests (vitest)
pnpm e2e                           # Playwright end-to-end tests
cd src-tauri && cargo test --lib   # Rust tests
```

The bundled plugins carry their own test suites in their repos under
`plugin-repos/`.

## Tech Stack

| Layer             | Technology                                     | Purpose                                  |
| ----------------- | ---------------------------------------------- | ---------------------------------------- |
| **Desktop Shell** | Tauri v2 (Rust)                                | Native window, transparency, plugin host |
| **Plugin system** | Rust dylib SDK + JS contribution registry      | Feature isolation, runtime loading       |
| **3D Rendering**  | Three.js + @pixiv/three-vrm 3.5 _(vrm plugin)_ | VRM rendering, blendshapes, expressions  |
| **STT**           | Moonshine Voice (Rust FFI) _(stt plugin)_      | On-device speech-to-text                 |
| **TTS**           | Supertonic-3 ONNX _(tts plugin)_               | Local speech synthesis                   |
| **MCP**           | rmcp (official Rust SDK) _(mcp plugin)_        | Model tool-calling server client         |
| **Frontend**      | React + TypeScript + Vitest                    | Shell UI, settings, plugin frontends     |

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Tauri Shell (Rust) — the core                                 │
│  ├─ lib.rs           window management, secrets, quit/restart  │
│  └─ plugin_host/     discovery, dylib loading (ABI-2), storage │
│                      seeding, zip import, plugin_call routing  │
└──────────────┬─────────────────────────────────────────────────┘
               │  plugin_call / plugin_read_frontend
       ┌───────▼───────────────────────────────────────┐
       │  Webview (React)                              │
       │  - contribution registry + slots/widgets      │
       │  - avatar bus (control seam + pixel probes)   │
       │  - settings shell rendering from the registry │
       └───────┬───────────────────────────────────────┘
               │  blob-import plugin frontends
       ┌───────▼───────────────────────────────────────┐
       │  Feature plugins                              │
       │  vrm (avatar engine) · chat · tts · stt       │
       │  alarms · calendar · mcp                      │
       └───────────────────────────────────────────────┘
```

### Data Flow

1. **Plugins activate** before first render: frontends are read from the
   plugin packages and loaded in-process; contributions register into the
   host registry.
2. **User speaks** → stt plugin recognition (on-device) → text
3. **Provider reply** streams tokens; the turn carries `motion` + `emotion`
4. **Text** → tts plugin TTS → audio + visemes → avatar bus → lipsync
5. **Emotion / motion** → avatar bus → the vrm plugin's engine drives the scene
6. **Idle mixer** → picks from the motion pool between turns

## Project Layout

```
.                                # repo root
├── src-tauri/                    # Tauri v2 core (Rust)
│   ├── src/
│   │   ├── main.rs, lib.rs       # windows, secrets, quit/restart
│   │   └── plugin_host/          # plugin system: discovery, dylib loading,
│   │                             #   commands, storage, seeding, zip import
│   └── build.rs                  # stages plugins/ into bundle resources
├── src/                          # frontend (React 19 + TypeScript)
│   ├── App.tsx                   # main window shell (slots, bus, click-through)
│   ├── settings.tsx              # settings window shell
│   ├── plugins/                  # host side: registry, slots, api, loader
│   ├── services/                 # TTS/STT provider registry seam
│   ├── avatar-bus.ts             # plugin ⇄ avatar engine seam
│   ├── events.ts                 # core event bridge (ui prefs)
│   ├── ui/                       # design kit, layouts, click-through
│   └── perf / ui-prefs / window-size
├── e2e/                          # Playwright end-to-end tests
├── public/                       # icons + bundled VRMA motion
├── scripts/                      # build-all-plugins.sh, build-plugin.mjs,
│                                 #   sign-macos.sh
├── plugin-repos/                 # bundled plugin sources (cloned in Setup)
├── plugins/                      # dev plugin discovery dir (default build
│                                 #   output, gitignored)
├── PLUGINS.md                    # plugin format + SDK guide
└── THIRD-PARTY-NOTICES.md        # bundled model licenses
```
