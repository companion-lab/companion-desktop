import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SectionCard } from "../molecules/SectionCard";
import { isWebBridge } from "../../web/bridge";

type WebStatus = {
  enabled: boolean;
  /** Persisted user toggle (Settings checkbox). False = server torn down. */
  userEnabled: boolean;
  envDisabled: boolean;
  lan: boolean;
  port: number;
  /** COMPANION_WEB_PORT env var overrides the port (field locked). */
  portLocked: boolean;
  /** Access password; null = open access (no password required). */
  password: string | null;
  lanIps: string[];
};

/** Clipboard on http origins (no async clipboard API) with a textarea fallback. */
function copyText(text: string): void {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(area);
  }
}

function UrlRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="st-webapp-url-row">
      <span className="st-webapp-url">{url}</span>
      <button type="button" className="preset-btn" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Web App: open this companion in a browser. Shows the URLs (localhost +
 * LAN), the port (restarts the server live), the access password (nullable —
 * empty means open access), and toggles LAN binding with a live server
 * restart. Also usable from the web itself — the toggle is what lets a
 * localhost session switch the server to LAN reachability.
 */
export function WebAppSection() {
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordSavedFlash, setPasswordSavedFlash] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [portSavedFlash, setPortSavedFlash] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    invoke<WebStatus>("web_status")
      .then((next) => {
        setStatus(next);
        setPasswordDraft(next.password ?? "");
        setPortDraft(String(next.port));
        setPortError(null);
      })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleLan = (enabled: boolean) => {
    setBusy(true);
    // The bridge restarts (its response races the old socket); re-read the
    // status after a beat — queued invokes resolve once the client
    // reconnects to the replacement server.
    invoke<WebStatus>("web_set_lan", { enabled })
      .then(() => setTimeout(refresh, 800))
      .catch((e) => console.error("[web] toggle failed:", e))
      .finally(() => setBusy(false));
  };

  // Master on/off: disabling tears the server down. When this runs from a
  // web page itself, that page's bridge dies with it (queued refresh fails
  // silently) — the desktop settings window is the way back in.
  const toggleEnabled = (enabled: boolean) => {
    setBusy(true);
    invoke<WebStatus>("web_set_enabled", { enabled })
      .then(() => setTimeout(refresh, 800))
      .catch((e) => console.error("[web] enable toggle failed:", e))
      .finally(() => setBusy(false));
  };

  const savePassword = () => {
    setBusy(true);
    // Empty input clears the password → open access (nullable).
    const password = passwordDraft.trim() === "" ? null : passwordDraft.trim();
    invoke<WebStatus>("web_set_password", { password })
      .then(setStatus)
      .catch((e) => console.error("[web] password save failed:", e))
      .finally(() => {
        setBusy(false);
        setPasswordSavedFlash(true);
        setTimeout(() => setPasswordSavedFlash(false), 1500);
      });
  };

  const parsedPort = portDraft.trim() === "" ? null : Number(portDraft);
  const portValid =
    parsedPort != null && Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const portDirty = status != null && !status.portLocked && portValid && parsedPort !== status.port;

  const savePort = () => {
    if (!portValid || parsedPort == null) return;
    setBusy(true);
    setPortError(null);
    // The bridge restarts on the new port; re-read the status after a beat
    // (from a browser tab the old origin is gone after the restart — the
    // desktop settings window is the reliable place to change this).
    invoke<WebStatus>("web_set_port", { port: parsedPort })
      .then(() => {
        setPortSavedFlash(true);
        setTimeout(() => setPortSavedFlash(false), 1500);
        setTimeout(refresh, 800);
      })
      .catch((e) => setPortError(String(e)))
      .finally(() => setBusy(false));
  };

  const localUrl = status ? `http://127.0.0.1:${status.port}/app` : null;
  // One row per interface: a VPN adds a tunnel IP the phone likely can't
  // reach — the user picks the one on their LAN. No ?password= suffix: the
  // password would be leaked by every copy/screenshot of these links, and
  // the browser asks for it once instead (the gate then saves it per-origin).
  const lanUrls =
    status?.lan
      ? (status.lanIps.length ? status.lanIps : ["<this-machine-ip>"]).map(
          (ip) => `http://${ip}:${status.port}/app`,
        )
      : [];

  const passwordDirty =
    status != null && (passwordDraft.trim() || null) !== status.password;

  return (
    <SectionCard title="Web App" badge={status?.enabled ? "running" : undefined}>
      {!status && (
        <span className="st-field-hint">Web app status unavailable (backend offline).</span>
      )}
      {status?.envDisabled && (
        <span className="st-field-hint">
          Disabled for this run (COMPANION_WEB=0). Remove the env var to enable.
        </span>
      )}
      {status && !status.envDisabled && (
        <>
          {/* Master on/off — above every other control so it's obvious the
              rows below only exist while the server is up. */}
          <label className="st-window-toggle">
            <input
              type="checkbox"
              checked={status.userEnabled}
              disabled={busy}
              onChange={(e) => toggleEnabled(e.target.checked)}
            />
            <span className="st-window-toggle-text">
              <span className="st-window-toggle-label">
                Enable web app {busy ? "(applying…)" : ""}
              </span>
              <span className="st-field-hint">
                Serves the companion and these settings as browser pages.
                Turning it off stops the server immediately — open browser
                connections drop and stay down until it's re-enabled here.
              </span>
            </span>
          </label>

          {status.userEnabled ? (
            <>
            <div className="st-field">
              <span className="st-field-label">
                <span>Open in a browser</span>
              </span>
              {localUrl && <UrlRow url={localUrl} />}
              <span className="st-field-hint">
                Same backend as this window: plugins, chat and storage are shared.
                Closing the app takes the website down.
              </span>
            </div>

            <div className="st-field">
              <span className="st-field-label">
                <span>Port</span>
              </span>
              <div className="st-webapp-url-row">
                <input
                  type="text"
                  inputMode="numeric"
                  className="st-webapp-url st-webapp-port-input"
                  value={portDraft}
                  disabled={busy || status.portLocked}
                  placeholder={String(status.port)}
                  onChange={(e) => {
                    setPortDraft(e.target.value);
                    setPortError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && portDirty && !busy) savePort();
                  }}
                />
                <button
                  type="button"
                  className="preset-btn"
                  disabled={busy || !portDirty}
                  onClick={savePort}
                >
                  {portSavedFlash ? "Saved" : "Save"}
                </button>
              </div>
              <span className="st-field-hint">
                {status.portLocked
                  ? "Overridden by the COMPANION_WEB_PORT environment variable — remove it to edit."
                  : portDraft.trim() !== "" && !portValid
                    ? "Port must be a number between 1 and 65535."
                    : "Server port (default 1421). Changing it restarts the server — open browser tabs need the new URL."}
              </span>
              {portError && (
                <span className="st-field-hint">Could not apply port: {portError}</span>
              )}
            </div>

            <div className="st-field">
              <span className="st-field-label">
                <span>Access password</span>
                <span className="st-field-value">
                  {status.password == null ? "open access" : "set"}
                </span>
              </span>
              <div className="st-webapp-url-row">
                <input
                  type="text"
                  className="st-webapp-url st-webapp-password-input"
                  value={passwordDraft}
                  placeholder="(no password — open access)"
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && passwordDirty && !busy) savePassword();
                  }}
                />
                <button
                  type="button"
                  className="preset-btn"
                  disabled={busy || !passwordDirty}
                  onClick={savePassword}
                >
                  {passwordSavedFlash ? "Saved" : "Save"}
                </button>
              </div>
              <span className="st-field-hint">
                Required by browser connections when LAN is on. Leave empty and
                save for open access (anyone on the network gets full backend
                access — chat, storage and secrets). Applies immediately.
              </span>
            </div>

            <label className="st-window-toggle">
              <input
                type="checkbox"
                checked={status.lan}
                disabled={busy}
                onChange={(e) => toggleLan(e.target.checked)}
              />
              <span className="st-window-toggle-text">
                <span className="st-window-toggle-label">
                  Reachable on the local network {busy ? "(restarting…)" : ""}
                </span>
                <span className="st-field-hint">
                  Binds the server on all interfaces. Opened pages keep working
                  across the restart.
                </span>
              </span>
            </label>

            {status.lan && (
              <div className="st-field">
                <span className="st-field-label">
                  <span>LAN addresses</span>
                </span>
                {lanUrls.map((url) => (
                  <UrlRow key={url} url={url} />
                ))}
                <span className="st-field-hint">
                  {status.password == null
                    ? "No password set — anyone on this network can open these."
                    : "The browser asks for the access password on first connect (it remembers it afterwards). Pick the address on your Wi-Fi network (VPN tunnels list one too)."}
                </span>
              </div>
            )}

            {isWebBridge() && (
              <span className="st-field-hint">
                You are viewing this page through the web bridge.
              </span>
            )}
            </>
          ) : (
            <span className="st-field-hint">
              Web app is off. Turn it on above to open this companion in a
              browser.
            </span>
          )}
        </>
      )}
    </SectionCard>
  );
}
