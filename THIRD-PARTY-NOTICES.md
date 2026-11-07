# Third-party notices

This project's code is licensed under the MIT License (see [LICENSE](./LICENSE)).
Third-party models, libraries, and assets bundled with or fetched by this
project retain their own licenses, listed below.

Each bundled plugin carries its own notices for the third-party content it
ships or fetches — see `../plugin-repos/companion-plugin-*/THIRD-PARTY-NOTICES.md`
(Moonshine speech-to-text in stt, Supertonic-3 text-to-speech and the demo
avatar model in tts/vrm, plugin JS and Rust dependencies elsewhere).

## JavaScript dependencies

MIT-licensed: `react`, `react-dom`. `@tauri-apps/api` and
`@tauri-apps/plugin-http` are MIT OR Apache-2.0. Their own license texts
ship inside `node_modules/`. Plugin frontends resolve React from the host
app at runtime and do not bundle it.

## Rust dependencies

The Rust dependency tree of the app (see `src-tauri/Cargo.lock`) is composed
of crates under MIT and/or Apache-2.0 (tauri, tokio, reqwest, keyring,
serde, chrono, and the rest of the ecosystem). Plugin backends each have
their own dependency tree, covered by their repos' notices. Run
`cargo install cargo-about && cargo about generate` for a machine-generated
per-crate report if you need the full list.
