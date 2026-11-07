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
# Rebuild all bundled feature plugins after editing sources in features/:
features/build-all.sh --backend
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
# Plugin frontend deps (vrm bundles Three.js; calendar vendors react-big-calendar)
cd features/vrm && pnpm install && cd ../..
cd features/calendar && pnpm install && cd ../..

# Speech plugin models + native lib (~660MB, feature-owned scripts)
cd features/stt && pnpm download:models && cd ../..   # Moonshine STT models + native lib
cd features/tts && pnpm download:models && cd ../..   # Supertonic TTS weights

# Build the bundled plugin packages
features/build-all.sh --backend

cd app
pnpm install
pnpm tauri dev
```

### Models & assets

| What                                                | Fetched by                            | License                                                                           |
| --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Supertonic-3 TTS weights                            | `features/tts` `pnpm download:models` | [OpenRAIL-M](../features/tts/assets/supertonic/LICENSE) (Supertone)               |
| Moonshine `medium-streaming-en` STT model           | `features/stt` `pnpm download:stt`    | MIT (Moonshine AI)                                                                |
| Moonshine prebuilt native library                   | `features/stt` `pnpm download:lib`    | MIT (Moonshine AI)                                                                |
| Default avatar `features/vrm/assets/model/demo.glb` | bundled in-repo                       | VRoid Hub uploader's terms — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |

Model weights are never committed; the scripts fetch them into gitignored
paths. Attribution and full license texts live in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Testing

```bash
pnpm test                          # frontend tests (vitest)
cd features/vrm && pnpm test       # avatar engine tests (vitest)
cd src-tauri && cargo test --lib   # Rust tests
```

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
│  ├─ plugin_host/     discovery, dylib loading (ABI-2), storage │
│  │                   seeding, zip import, plugin_call routing  │
│  ├─ hotkey.rs        global shortcuts                          │
│  └─ perf.rs          performance config                        │
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
companion/                       # repo root
├── src-tauri/                    # Tauri v2 core (Rust)
│   ├── src/
│   │   ├── main.rs, lib.rs       # windows, secrets, quit/restart
│   │   ├── plugin_host/          # plugin system: discovery, dylib loading,
│   │   │                         #   commands, storage, seeding, zip import
│   │   ├── hotkey.rs             # global shortcuts
│   │   └── perf.rs               # performance config
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
├── scripts/                      # build-plugin.mjs (dev builds), sign-macos.sh
├── plugins -> ../plugins         # dev discovery symlink
├── PLUGINS.md                    # plugin format + SDK guide
└── THIRD-PARTY-NOTICES.md        # bundled model licenses
```
