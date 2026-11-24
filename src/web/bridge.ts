// Browser polyfill for the Tauri IPC runtime, talking to the desktop app's
// web bridge (src-tauri/src/web_bridge/).
//
// When the page is served by the bridge server (or opened with ?web=1 through
// the vite proxy), this installs the exact `window.__TAURI_INTERNALS__`/
// `window.isTauri` surfaces the core frontend and every plugin bundle read
// (verified against @tauri-apps/api 2.12.1 and the plugins' vendored
// tauri.ts bridges):
//
//   invoke(cmd, args, options)        -> dispatch.rs routes to the real backend
//   transformCallback / runCallback   -> events, channels, global shortcuts
//   metadata.currentWindow.label      -> "web" (virtual window; mutations
//                                        no-op server-side)
//   convertFileSrc(path)              -> /__bridge/asset (same origin)
//   __TAURI_EVENT_PLUGIN_INTERNALS__  -> no-op unregisterListener
//
// Access control: when the server has a password, this page must know it.
// The polyfill probes /__bridge/auth with the ?password= URL param or the
// per-origin value saved in localStorage; without a working one it shows a
// password gate before connecting. The password is never delivered by the
// server's HTML.
//
// Without the flag this module is inert: plain-browser runs keep the existing
// degraded no-backend behavior (see plugins/host.ts).

const WEB_WINDOW_LABEL = "web";
const PASSWORD_STORAGE_KEY = "companion:web-password";

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface QueuedInvoke {
  entry: PendingInvoke;
  cmd: string;
  payload?: unknown;
  bodyB64?: string;
}

type ServerFrame =
  | { type: "resp"; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: "cb"; id: number; data: unknown };

// Module state — a page connects to exactly one bridge.
let nextInvokeId = 1;
let nextCallbackId = 1;
let socket: WebSocket | null = null;
let socketReady = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectFailures = 0;
/** The password validated against /__bridge/auth (null = open access). */
let activePassword: string | null = null;
const callbacks = new Map<number, { handler: (data: unknown) => void; once: boolean }>();
const pendingByInvokeId = new Map<number, PendingInvoke>();
const queued: QueuedInvoke[] = [];

/** True when this page should run against the web bridge. */
function webBridgeRequested(): boolean {
  if (typeof window === "undefined") return false;
  if ("__COMPANION_WEB__" in window) return true;
  return new URLSearchParams(window.location.search).has("web");
}

function urlPassword(): string | null {
  return new URLSearchParams(window.location.search).get("password");
}

function storedPassword(): string | null {
  try {
    return localStorage.getItem(PASSWORD_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** True on pages running against the web bridge (set by installWebBridge). */
export function isWebBridge(): boolean {
  return typeof window !== "undefined" && "__COMPANION_WEB_BRIDGE__" in window;
}

/**
 * Install the polyfill. Must be the first call of a page's entry module,
 * before anything invokes or checks isTauri() — it runs synchronously, and
 * invoke()/listen() queue until the WebSocket connects (which waits for the
 * password gate when one is required).
 */
export function installWebBridge(): void {
  if (!webBridgeRequested()) return;
  if ("__TAURI_INTERNALS__" in window) return; // native webview: never touch

  void bootstrapConnection();

  Object.defineProperty(window, "isTauri", {
    value: true,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(window, "__COMPANION_WEB_BRIDGE__", {
    value: true,
    configurable: false,
  });

  const internals = {
    metadata: {
      currentWindow: { label: WEB_WINDOW_LABEL },
      currentWebview: { label: WEB_WINDOW_LABEL },
    },
    plugins: {},
    transformCallback: (callback?: (data: unknown) => void, once = false): number => {
      const id = nextCallbackId++;
      if (callback) callbacks.set(id, { handler: callback, once });
      return id;
    },
    unregisterCallback: (id: number): void => {
      callbacks.delete(id);
    },
    runCallback: (id: number, data: unknown): void => {
      const entry = callbacks.get(id);
      if (!entry) return;
      if (entry.once) callbacks.delete(id);
      entry.handler(data);
    },
    convertFileSrc: (filePath: string, _protocol = "asset"): string => {
      const password = activePassword;
      const passwordParam = password ? `&password=${encodeURIComponent(password)}` : "";
      return `${window.location.origin}/__bridge/asset?path=${encodeURIComponent(
        filePath,
      )}${passwordParam}`;
    },
    invoke: (
      cmd: string,
      args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
      _options?: unknown,
    ): Promise<unknown> => {
      return dispatchInvoke(cmd, args);
    },
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: internals,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    value: {
      // npm event.listen calls this before plugin:event|unlisten; the real
      // runtime keeps its own listener map, the bridge tracks server-side.
      unregisterListener: (): void => {},
    },
    writable: false,
    configurable: false,
  });
}

// --- connection bootstrap: resolve the password, then open the socket -------

/** "ok" | wrong password | server unreachable. */
async function probePassword(
  password: string | null,
): Promise<"ok" | "rejected" | "down"> {
  const param = password != null ? `&password=${encodeURIComponent(password)}` : "";
  try {
    const res = await fetch(`/__bridge/auth?path=probe${param}`);
    return res.status === 200 ? "ok" : "rejected";
  } catch {
    return "down";
  }
}

async function bootstrapConnection(): Promise<void> {
  const candidates: Array<string | null> = [];
  for (const candidate of [urlPassword(), storedPassword(), null]) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const verdict = await probePassword(candidate);
    if (verdict === "down") {
      // Server restarting or absent — retry a beat later, don't gate yet.
      setTimeout(() => void bootstrapConnection(), 1500);
      return;
    }
    if (verdict === "ok") {
      activatePassword(candidate);
      connectSocket();
      return;
    }
  }
  // No candidate (URL param, saved value, or open access) was accepted.
  showGate();
}

function activatePassword(password: string | null): void {
  activePassword = password;
  if (password != null) {
    try {
      localStorage.setItem(PASSWORD_STORAGE_KEY, password);
    } catch {
      /* private mode etc. — reconnects will just re-prompt */
    }
  }
}

function bridgeWsUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const suffix =
    activePassword != null ? `?password=${encodeURIComponent(activePassword)}` : "";
  return `${scheme}//${window.location.host}/__bridge/ws${suffix}`;
}

function connectSocket(): void {
  if (socket) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(bridgeWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    socketReady = true;
    connectFailures = 0;
    for (const invoke of queued.splice(0)) startInvoke(invoke);
  };
  ws.onmessage = (event) => {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(event.data as string) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "cb") {
      runCallback(frame.id, frame.data);
      return;
    }
    const pending = pendingByInvokeId.get(frame.id);
    if (!pending) return;
    pendingByInvokeId.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value ?? null);
    else pending.reject(new Error(frame.error ?? "web bridge invoke failed"));
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    socketReady = false;
    // Anything in flight dies with the socket; retry with backoff (the
    // desktop app may just be restarting). After a few failures, re-check
    // the password: it may have been changed from another window.
    for (const pending of pendingByInvokeId.values()) {
      pending.reject(new Error("web bridge connection closed"));
    }
    pendingByInvokeId.clear();
    if (reconnectTimer) return;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose follows; nothing to do here.
  };
}

function scheduleReconnect(): void {
  connectFailures += 1;
  const delay = Math.min(1500 * connectFailures, 10_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (connectFailures >= 3) {
      void revalidateAndReconnect();
      return;
    }
    connectSocket();
  }, delay);
}

/** Re-probe the stored password; a rejection reopens the gate. */
async function revalidateAndReconnect(): Promise<void> {
  const verdict = await probePassword(activePassword);
  if (verdict === "rejected") {
    connectFailures = 0;
    try {
      localStorage.removeItem(PASSWORD_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    activePassword = null;
    showGate();
    return;
  }
  connectSocket();
}

/** invoke() entry point: serialize, send if online, queue while offline. */
function dispatchInvoke(cmd: string, rawArgs?: unknown): Promise<unknown> {
  const { payload, bodyB64 } = serializeArgs(rawArgs);
  return new Promise<unknown>((resolve, reject) => {
    const invoke: QueuedInvoke = { entry: { resolve, reject }, cmd, payload, bodyB64 };
    if (socketReady && socket) startInvoke(invoke);
    else queued.push(invoke);
  });
}

function startInvoke(invoke: QueuedInvoke): void {
  const id = nextInvokeId++;
  pendingByInvokeId.set(id, invoke.entry);
  socket?.send(
    JSON.stringify({ type: "invoke", id, cmd: invoke.cmd, payload: invoke.payload, bodyB64: invoke.bodyB64 }),
  );
}

// --- password gate -----------------------------------------------------------

function showGate(): void {
  if (document.getElementById("companion-gate")) return;
  const overlay = document.createElement("div");
  overlay.id = "companion-gate";
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,10,14,.94);z-index:2147483647;font-family:system-ui,sans-serif;color:#fff">
      <div style="background:#141821;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:26px;width:min(320px,86vw);text-align:center">
        <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#8f9aab">Companion</div>
        <div style="font-size:14px;line-height:1.5;margin:12px 0 14px;color:#dfe4ec">This companion is password protected.<br>Enter the access password.</div>
        <input id="companion-gate-input" type="password" autocomplete="off" style="width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:#0d1017;color:#fff;font-size:14px" />
        <button id="companion-gate-go" style="margin-top:12px;width:100%;padding:9px;border-radius:9px;border:0;background:#4f7cff;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Connect</button>
        <div id="companion-gate-err" style="margin-top:10px;font-size:12px;color:#f87171;min-height:16px"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector<HTMLInputElement>("#companion-gate-input")!;
  const button = overlay.querySelector<HTMLButtonElement>("#companion-gate-go")!;
  const error = overlay.querySelector<HTMLElement>("#companion-gate-err")!;
  const attempt = async () => {
    const candidate = input.value.trim();
    if (!candidate) {
      error.textContent = "Enter the access password (or clear it in the app's settings for open access).";
      return;
    }
    button.disabled = true;
    const verdict = await probePassword(candidate);
    button.disabled = false;
    if (verdict === "down") {
      error.textContent = "Companion app unreachable right now — try again.";
      return;
    }
    if (verdict === "rejected") {
      error.textContent = "Wrong password.";
      return;
    }
    activatePassword(candidate);
    overlay.remove();
    connectSocket();
  };
  button.addEventListener("click", () => void attempt());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void attempt();
  });
  input.focus();
}

/**
 * Serialize invoke args the way Tauri's processIpcMessage does: toJSON
 * handlers (Channel → "__CHANNEL__:<id>", dpi sizes → {Logical:…}) ride
 * JSON.stringify, Uint8Array/ArrayBuffer become number arrays, and a
 * top-level binary payload travels as base64 (plugin_import_archive).
 */
function serializeArgs(rawArgs?: unknown): { payload?: unknown; bodyB64?: string } {
  if (rawArgs == null) return { payload: null };
  if (rawArgs instanceof ArrayBuffer) {
    return { bodyB64: bytesToBase64(new Uint8Array(rawArgs)) };
  }
  if (ArrayBuffer.isView(rawArgs)) {
    return {
      bodyB64: bytesToBase64(
        new Uint8Array(rawArgs.buffer, rawArgs.byteOffset, rawArgs.byteLength),
      ),
    };
  }
  const json = JSON.stringify(rawArgs, (_key, value: unknown) => {
    if (value instanceof Uint8Array) return Array.from(value);
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    return value;
  });
  return { payload: JSON.parse(json) };
}

// --- runCallback indirection (shared by events, channels, shortcuts) --------

function runCallback(id: number, data: unknown): void {
  const entry = callbacks.get(id);
  if (!entry) return;
  if (entry.once) callbacks.delete(id);
  entry.handler(data);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
