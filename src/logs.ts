// Console capture → Rust log sink (src-tauri/src/logs.rs). Every webview's
// console (main, settings, and any plugin frontend loaded into them) funnels
// through here so the Settings > Logs panel can read the whole app's output
// in one place — console lines are otherwise per-webview and, in release
// builds, invisible without devtools.
//
// Install it right after the web bridge (invoke needs the bridge installed on
// web pages) and before the plugin host (so plugin logs are captured too).

import { invoke } from "@tauri-apps/api/core";

type Level = "info" | "warn" | "error";

// Longest formatted message sent to the sink. A single line can carry a
// pretty-printed LLM request body (~tens of KB) or a full request dump; the
// panel scrolls, but the sink (and the event payload) should stay bounded.
const MAX_MSG_CHARS = 32_000;

let installed = false;

/** Idempotent: wraps console.log/info/warn/error once per webview. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;

  const wrap = (
    level: Level,
    orig: (...args: unknown[]) => void,
  ): ((...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      try {
        const message = formatArgs(args);
        if (message) {
          // Fire-and-forget; on a plain browser dev run (no sink) this just
          // fails silently — the devtools console still has the line.
          invoke("log_push", { level, message }).catch(() => {});
        }
      } catch {
        /* capture must never break logging */
      }
      orig(...args);
    };
  };

  console.log = wrap("info", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
}

function formatArgs(args: unknown[]): string {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === "string") {
      parts.push(a);
    } else if (a instanceof Error) {
      // Keep the stack trace — it's what makes an error traceable in the
      // panel. V8 stacks already start with "Name: message", so prefer them.
      parts.push(a.stack ?? `${a.name}: ${a.message}`);
    } else if (typeof a === "object" && a !== null) {
      try {
        parts.push(JSON.stringify(a));
      } catch {
        parts.push(String(a));
      }
    } else {
      parts.push(String(a));
    }
  }
  const joined = parts.join(" ");
  return joined.length > MAX_MSG_CHARS
    ? joined.slice(0, MAX_MSG_CHARS) + `… (+${joined.length - MAX_MSG_CHARS} chars)`
    : joined;
}
