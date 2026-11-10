// Software update section: checks GitHub Releases for a newer build, downloads
// the platform installer zip, and hands the installer to the OS. Registered as
// a core section on the About tab (builtin.tsx); the update commands live in
// src-tauri/src/updater.rs.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { SectionCard } from "../molecules/SectionCard";
import { Button } from "../atoms/Button";
import { ConfirmModal } from "../molecules/ConfirmModal";

type UpdateInfo = {
  currentVersion: string;
  latestVersion: string | null;
  tagName: string | null;
  notes: string | null;
  publishedAt: string | null;
  downloadUrl: string | null;
  assetSize: number | null;
  htmlUrl: string;
  isNewer: boolean;
};

type Progress = { received: number; total: number | null };

/** MB with a single digit (asset sizes come back in bytes). */
function mb(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes <= 0) return null;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function UpdateSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  // Held open against ConfirmModal while the user decides whether to run the
  // downloaded installer right away.
  const [installer, setInstaller] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live flow events from the background download thread; like plugin
  // import/restore, the command returns before the work does.
  useEffect(() => {
    void getVersion().then(
      (v) => setVersion(v),
      () => setVersion(null),
    );
    const un = Promise.all([
      listen<Progress>("update-download-progress", (e) => setProgress(e.payload)),
      listen<{ installerPath: string }>("update-download-complete", (e) => {
        setDownloading(false);
        setProgress(null);
        setInstaller(e.payload.installerPath);
      }),
      listen<{ message: string }>("update-download-failed", (e) => {
        setDownloading(false);
        setProgress(null);
        setError(e.payload.message);
      }),
    ]);
    return () => {
      void un.then(
        (all) => all.forEach((fn) => fn()),
        () => {},
      );
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setInfo(await invoke<UpdateInfo>("check_for_update"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  const download = useCallback(async () => {
    if (!info?.downloadUrl || !info.tagName) return;
    setDownloading(true);
    setProgress(null);
    setError(null);
    try {
      // Fire-and-forget on the Rust side: progress and completion arrive as
      // events (see the listener above).
      await invoke("download_update", {
        download_url: info.downloadUrl,
        tag_name: info.tagName,
      });
    } catch (e) {
      setDownloading(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [info]);

  const openReleases = useCallback(async () => {
    if (!info) return;
    try {
      await invoke("open_url", { url: info.htmlUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [info]);

  const installNow = useCallback(async () => {
    if (!installer) return;
    setInstalling(true);
    setError(null);
    try {
      await invoke("open_update_installer", { path: installer });
      // Hand the app over to the installer: quit so files unlock while the
      // installer runs (its own short delay lets this IPC response land).
      await invoke("quit_app");
    } catch (e) {
      setInstalling(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [installer]);

  const checkButton = (
    <Button onClick={() => void check()} disabled={checking}>
      {checking ? "Checking…" : info ? "Check again" : "Check for updates"}
    </Button>
  );

  let body: React.ReactNode;
  if (!info) {
    body = (
      <div className="st-update-row">
        <p className="st-hint">
          Check GitHub for a newer release. The installer is downloaded and
          opened for you — the app quits while it runs.
        </p>
        {checkButton}
      </div>
    );
  } else if (!info.isNewer) {
    body = (
      <div className="st-update-row">
        <p className="st-hint">
          Companion is up to date
          {info.tagName ? <> — latest release is {info.tagName}</> : null}.
        </p>
        {checkButton}
      </div>
    );
  } else {
    const pct =
      progress?.total && progress.total > 0
        ? Math.min(100, Math.round((progress.received / progress.total) * 100))
        : null;
    body = (
      <>
        <div className="st-update-row">
          <div className="st-update-copy">
            <div className="st-update-title">
              Update available: v{info.latestVersion ?? info.tagName}
              {info.publishedAt && (
                <span className="st-update-date">
                  {" · "}
                  {new Date(info.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {mb(info.assetSize) && (
              <p className="st-hint">{mb(info.assetSize)} zipped download</p>
            )}
          </div>
          <div className="st-update-actions">
            <Button variant="ghost" onClick={() => void openReleases()}>
              View on GitHub
            </Button>
            <Button
              variant="primary"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? "Downloading…" : "Download update"}
            </Button>
          </div>
        </div>
        {downloading && progress && (
          <>
            <div
              className="st-update-progress"
              role="progressbar"
              aria-valuenow={pct ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="st-update-progress-fill"
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
            <p className="st-update-progress-text">
              {pct != null
                ? `${pct}% · ${mb(progress.received) ?? ""} / ${mb(progress.total) ?? ""}`
                : `${mb(progress.received) ?? ""} downloaded`}
            </p>
          </>
        )}
        {info.notes && (
          <div className="st-update-notes">{info.notes}</div>
        )}
      </>
    );
  }

  return (
    <SectionCard
      title="Software update"
      badge={version ? `v${version}` : undefined}
    >
      {error && (
        <p className="st-hint" style={{ color: "#e5484d" }} role="alert">
          {error}
        </p>
      )}
      {body}
      {installer && (
        <ConfirmModal
          title="Install update?"
          message={`Open the downloaded installer${version && info?.latestVersion ? ` for v${info.latestVersion}` : ""} and quit Companion? The app restarts from the installed update.`}
          confirmLabel="Open installer & quit"
          confirmVariant="primary"
          busy={installing}
          onClose={() => !installing && setInstaller(null)}
          onConfirm={() => void installNow()}
        />
      )}
    </SectionCard>
  );
}
