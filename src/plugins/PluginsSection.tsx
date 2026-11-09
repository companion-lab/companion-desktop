// Settings UI for the plugin system itself: lists discovered plugins with
// enable/disable, permissions, and load errors; supports importing a plugin
// from a .zip archive. Dogfoods the same contribution API as everything else
// (registered in builtin.tsx).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { SectionCard } from "../ui/molecules/SectionCard";
import { Button } from "../ui/atoms/Button";
import { ConfirmModal } from "../ui/molecules/ConfirmModal";
import { disablePlugins, enablePlugin } from "./host";
import type { PluginInfo } from "./types";

export function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PluginInfo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enable/disable/delete/restore persist immediately and apply to the open
  // windows right away; the reload (both webviews, clean state) is deferred
  // so several plugins can be changed before one reset.
  const [pendingRestart, setPendingRestart] = useState(false);
  // Restore/import finish asynchronously on the Rust side (their commands
  // return before the work does); these flags clear the spinner state when
  // the completion event arrives. Frontend activation for freshly installed
  // plugins is handled by the host's plugins-changed sync in every window.
  const restoreFollowUpRef = useRef(false);
  const importRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await invoke<PluginInfo[]>("plugin_list"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const un = listen<PluginInfo[]>("plugins-changed", (e) => {
      setPlugins(e.payload);
      setPendingRestart(true);
      // Restore/import run in the background on the Rust side and signal
      // completion through this event: clear the spinner state here.
      if (restoreFollowUpRef.current) {
        restoreFollowUpRef.current = false;
        setRestoring(false);
      } else if (importRef.current) {
        importRef.current = false;
        setImporting(false);
      }
    });
    return () => {
      void un.then(
        (fn) => fn(),
        () => {},
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reload both webviews so every deferred change applies from a clean
   *  state (Process restart via restart_app doesn't work in dev mode, so we
   *  reload the webviews via an event instead). */
  const resetApp = useCallback(async () => {
    await emit("app-reload", null);
    setTimeout(() => window.location.reload(), 100);
  }, []);

  const toggle = useCallback(
    async (plugin: PluginInfo) => {
      setBusy(plugin.id);
      setError(null);
      try {
        const next = !plugin.enabled;
        await invoke("plugin_set_enabled", {
          plugin_id: plugin.id,
          enabled: next,
        });
        // Apply the frontend change live: activate the bundle on enable, drop
        // its contributions on disable. Backends keep running until reset.
        if (next) {
          if (plugin.hasFrontend) await enablePlugin(plugin.id, true);
        } else {
          disablePlugins([plugin.id]);
        }
        await refresh();
        setPendingRestart(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setError(null);
      try {
        // Send the raw bytes as the IPC request body instead of a base64 data
        // URL: the JSON/base64 path multiplies a large package's memory several
        // times over in the webview and dies with "Out of memory" on ~400 MB
        // plugin zips.
        const bytes = await file.arrayBuffer();
        // Fire-and-forget on the Rust side: the command returns before the
        // import finishes, and the plugins-changed event completes the flow
        // (frontend activation + pending-restart flag).
        importRef.current = true;
        await invoke("plugin_import_archive", new Uint8Array(bytes));
        await refresh();
      } catch (e) {
        importRef.current = false;
        setImporting(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [refresh],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(pendingDelete.id);
    setError(null);
    try {
      await invoke("plugin_delete", { plugin_id: pendingDelete.id });
      // Drop the deleted plugin's live contributions; its backend keeps
      // running until the next reset (backends are never unloaded).
      disablePlugins([pendingDelete.id]);
      setPendingDelete(null);
      await refresh();
      setPendingRestart(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }, [pendingDelete, refresh]);

  const restoreBundled = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      // Fire-and-forget on the Rust side: the command returns before the
      // restore finishes, and the plugins-changed event completes the flow
      // (frontend activation + pending-restart flag).
      restoreFollowUpRef.current = true;
      await invoke("plugin_restore_bundled");
      await refresh();
    } catch (e) {
      restoreFollowUpRef.current = false;
      setRestoring(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  if (plugins === null) {
    return (
      <SectionCard title="Plugins">
        <p className="st-hint">{error ?? "Loading…"}</p>
      </SectionCard>
    );
  }

  // Search filter: match against the plugin's identity, description and
  // permissions, case-insensitively. An empty/whitespace query lists all.
  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? plugins
      : plugins.filter((p) =>
          [p.id, p.name, p.description, ...p.permissions]
            .join(" ")
            .toLowerCase()
            .includes(q),
        );

  return (
    <SectionCard
      title="Plugins"
      badge={
        q !== ""
          ? `${filtered.length} / ${plugins.length}`
          : `${plugins.length}`
      }
    >
      {pendingRestart && (
        <div className="st-plugins-pending">
          <span className="st-plugins-pending-text">
            <strong>Plugin changes pending.</strong> Reset now reloads both
            windows and applies everything from a clean state — backends fully
            unload on the next launch.
          </span>
          <Button variant="primary" onClick={() => void resetApp()}>
            Reset now
          </Button>
        </div>
      )}
      {error && (
        <p className="st-hint" style={{ color: "#e5484d" }}>
          {error}
        </p>
      )}
      {/* Toolbar: search beside the import/restore actions. Wraps on narrow
          windows instead of cramming the card head. */}
      <div className="st-plugins-toolbar">
        {plugins.length > 0 && (
          <div className="st-search">
            <input
              type="text"
              value={query}
              placeholder="Search plugins…"
              aria-label="Search plugins"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== "" && (
              <button
                type="button"
                className="st-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportFile(f);
          }}
        />
        <Button
          variant="primary"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
        >
          {importing ? "Importing…" : "Import plugin…"}
        </Button>
        <Button
          variant="secondary"
          disabled={restoring}
          onClick={() => void restoreBundled()}
          title="Reinstall any bundled features you uninstalled"
        >
          {restoring ? "Restoring…" : "Restore bundled features"}
        </Button>
      </div>
      {plugins.length === 0 ? (
        <p className="st-hint">
          No plugins installed. Click <strong>Import plugin…</strong> to load a
          <code>.zip</code> plugin package, or drop one into the{" "}
          <code>plugins</code> folder in the app data directory and reload.
        </p>
      ) : filtered.length === 0 ? (
        <p className="st-hint">
          No plugins match <strong>"{query.trim()}"</strong>.
        </p>
      ) : (
        <div className="plugin-list">
          {filtered.map((p) => (
            <div
              key={p.id}
              className={`plugin-row${p.enabled ? "" : " plugin-row-disabled"}`}
            >
              <div className="plugin-info">
                <div className="plugin-title">
                  <span className="plugin-name">{p.name}</span>
                  <span className="plugin-version">v{p.version}</span>
                  {p.bundled && (
                    <span
                      className="st-card-badge"
                      title="Ships with the app — can be restored after Delete"
                    >
                      bundled
                    </span>
                  )}
                  {p.hasBackend && (
                    <span
                      className={`st-card-badge${p.backendLoaded ? "" : " plugin-badge-warn"}`}
                    >
                      {p.backendLoaded ? "backend loaded" : "backend off"}
                    </span>
                  )}
                </div>
                {p.description && (
                  <div className="plugin-desc">{p.description}</div>
                )}
                {p.permissions.length > 0 && (
                  <div className="plugin-perms">
                    {p.permissions.map((perm) => (
                      <span key={perm} className="plugin-perm">
                        {perm}
                      </span>
                    ))}
                  </div>
                )}
                {p.loadError && (
                  <div className="plugin-error" role="alert">
                    Backend failed to load: {p.loadError}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy === p.id}
                  aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                  onClick={() => void toggle(p)}
                >
                  {busy === p.id ? "…" : p.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={deleting === p.id}
                  aria-label={`Delete ${p.name}`}
                  onClick={() => setPendingDelete(p)}
                >
                  {deleting === p.id ? "…" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="st-hint">
        Changes apply immediately in the open windows, so you can toggle or
        remove several plugins before resetting. Fully unloading a Rust backend
        needs an app restart. Imported plugins are copied into the app data
        directory.
      </p>

      {pendingDelete && (
        <ConfirmModal
          title="Delete plugin?"
          message={
            pendingDelete.bundled
              ? `Remove "${pendingDelete.name}"? Its data is kept and it can be reinstalled with "Restore bundled features".`
              : `Delete "${pendingDelete.name}"? This removes the plugin from disk and cannot be undone.`
          }
          busy={deleting !== null}
          onClose={() => deleting === null && setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </SectionCard>
  );
}
