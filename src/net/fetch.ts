// Host-side HTTP layer: the doFetch/canStream/throwIfHttpError surface the
// plugins vendored from this file (see e.g.
// plugin-repos/companion-plugin-chat/src/net/fetch.ts). Whenever a Tauri IPC
// surface exists the request rides the Rust backend via
// @tauri-apps/plugin-http: not subject to CORS in the native webview, and on
// the web bridge the plugin:http|fetch invokes are tunneled over /__bridge/ws
// to web_bridge::http_fetch, whose reqwest client runs inside the desktop
// process — endpoints only the desktop can reach (localhost/LAN services)
// therefore work from a browser page too. Plain-browser runs without the
// bridge (degraded, no plugin host) fall back to the browser's own fetch.
//
// Call sites that need webview-specific behavior — data: URLs, same-origin
// probes (web/bridge.ts auth), cookies — keep plain fetch.

import { fetch as tauriFetch, type ClientOptions } from "@tauri-apps/plugin-http";

/** RequestInit plus the Rust client options @tauri-apps/plugin-http accepts. */
type FetchInit = RequestInit & Partial<ClientOptions>;

export async function doFetch(url: string, init?: FetchInit): Promise<Response> {
  if (isTauri()) {
    // plugin-http's fetch deletes its Rust client extensions
    // (maxRedirections/connectTimeout/proxy/danger) off the init object it is
    // handed — pass a copy so caller-owned objects stay untouched.
    return tauriFetch(url, init ? { ...init } : undefined);
  }
  return fetch(url, init);
}

export function canStream(res: Response): boolean {
  return !!res.body && typeof res.body.getReader === "function";
}

export async function throwIfHttpError(res: Response): Promise<void> {
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
}

// Same runtime check as plugins/host.ts isTauri() and the plugins' vendored
// bridges: the web bridge installs __TAURI_INTERNALS__ in browsers too, so
// "tauri fetch on web" is exactly this branch.
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
