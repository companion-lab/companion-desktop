//! Plugin updates: the settings UI checks each plugin's manifest-declared
//! `versionCheckUrl` for a newer version (`plugin_check_updates`) and can
//! download the package from `updateUrl` and re-import it in place
//! (`plugin_update`). Mirrors the app updater (updater.rs): blocking reqwest
//! on a worker thread, fire-and-forget commands, completion through events.

use std::io::Read;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, State};

use super::{PluginHostState, PluginManifest};
use crate::updater::{asset_platform, is_newer_version};

/// Download lifecycle events, consumed by the settings webview (same pattern
/// as the app updater's update-download-* events). Successful completion is
/// the plugin host's regular `plugins-changed` broadcast, emitted by
/// import_archive when the new package lands.
const PROGRESS_EVENT: &str = "plugin-update-progress";
const FAILED_EVENT: &str = "plugin-update-failed";

/// Progress events are throttled to this granularity: chunk reads fire far
/// faster than a progress bar needs, and large packages (model-heavy plugins
/// reach ~400 MB) would otherwise flood the event bridge.
const PROGRESS_STEP: u64 = 512 * 1024;

/// One plugin's version-check result (`plugin_check_updates`). Plugins
/// without a manifest `versionCheckUrl` are not listed at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub plugin_id: String,
    pub current_version: String,
    /// Newest version seen at the check URL; `None` when the check failed.
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    plugin_id: String,
    received: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFailure {
    plugin_id: String,
    message: String,
}

/// Check every plugin that declares a `versionCheckUrl`. Runs on the blocking
/// pool: each check is a network round trip that may take as long as it wants
/// (plugin_call's spawn_blocking rule).
#[tauri::command(rename_all = "snake_case")]
pub async fn plugin_check_updates(
    state: State<'_, PluginHostState>,
) -> Result<Vec<PluginUpdateInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || Ok(check_all(&state)))
        .await
        .map_err(|e| format!("update check failed: {e}"))?
}

/// Download a plugin's update package and re-import it in place (full package
/// replace, backend reload — the import_archive path). Fire-and-forget like
/// plugin_import_archive: long-running commands lose their IPC responses on
/// macOS while the webview's scheme task stays open, so the command returns
/// before the work does and progress/completion arrives through events.
#[tauri::command(rename_all = "snake_case")]
pub fn plugin_update(
    state: State<'_, PluginHostState>,
    plugin_id: String,
    latest_version: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    std::thread::spawn(move || {
        if let Err(e) = download_and_import(&state, &plugin_id, &latest_version) {
            eprintln!("[plugins] update {plugin_id} failed: {e}");
            let _ = state.inner.app.emit(
                FAILED_EVENT,
                UpdateFailure {
                    plugin_id,
                    message: e,
                },
            );
        }
    });
    Ok(())
}

fn check_all(state: &PluginHostState) -> Vec<PluginUpdateInfo> {
    let client = check_client();
    state
        .list()
        .into_iter()
        .filter_map(|p| p.version_check_url.map(|url| (p.id, p.version, url)))
        .map(|(id, version, url)| check_one(&client, &id, &version, &url))
        .collect()
}

fn check_one(
    client: &reqwest::blocking::Client,
    plugin_id: &str,
    current: &str,
    url: &str,
) -> PluginUpdateInfo {
    match fetch_version(client, url) {
        Ok(latest) => PluginUpdateInfo {
            plugin_id: plugin_id.into(),
            current_version: current.into(),
            latest_version: Some(latest.clone()),
            update_available: is_newer_version(current, &latest),
            error: None,
        },
        Err(e) => PluginUpdateInfo {
            plugin_id: plugin_id.into(),
            current_version: current.into(),
            latest_version: None,
            update_available: false,
            error: Some(e),
        },
    }
}

/// Fetch the check URL and parse the newest version out of it. A redirect
/// whose target path carries a `releases/tag/<version>` segment (GitHub's
/// `…/releases/latest` lands on `…/releases/tag/v0.4.0`) wins first — that is
/// the website route, which unlike the api.github.com route has no per-IP
/// rate limit to exhaust. Everything else falls back to body parsing.
fn fetch_version(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = resp.status();
    // Some check endpoints (e.g. api.github.com) rate-limit per IP; make it a
    // readable error.
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("update check rate-limited (HTTP 403); try again later".into());
    }
    if !status.is_success() {
        return Err(format!("update check responded with {status}"));
    }
    if let Some(version) = version_from_tag_path(resp.url().path()) {
        return Ok(version);
    }
    let body = resp
        .text()
        .map_err(|e| format!("unreadable update-check response: {e}"))?;
    parse_check_response(&body)
        .ok_or_else(|| "could not parse a version from the update-check response".into())
}

/// Version encoded in a redirect target's path: the segment after `tag` when
/// it looks like a version (`…/releases/tag/v0.4.0` → `0.4.0`). GitHub's
/// website `releases/latest` route redirects there; so does Gitea.
fn version_from_tag_path(path: &str) -> Option<String> {
    let mut segments = path.split('/');
    while let Some(segment) = segments.next() {
        if segment != "tag" {
            continue;
        }
        let tag = segments.next()?;
        let stripped = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
        return looks_like_version(stripped).then(|| stripped.to_string());
    }
    None
}

/// Parse a version out of a check response. Accepted, in order: a JSON object
/// with a `tag_name` (GitHub Releases, `v` prefix stripped) or `version`
/// field, a bare JSON string, or a plain-text body (first line that looks
/// like a version, so an HTML error page is not mistaken for one).
pub fn parse_check_response(body: &str) -> Option<String> {
    let trimmed = body.trim();
    let from_text = || {
        trimmed
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && l.len() <= 64 && looks_like_version(l))
            .map(|l| l.strip_prefix(['v', 'V']).unwrap_or(l).to_string())
    };
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        // A bare version like "0.4" parses as a JSON number, so a non-object,
        // non-string parse falls back to the text path rather than failing.
        Ok(serde_json::Value::Object(obj)) => {
            for key in ["tag_name", "version"] {
                if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
                    let v = v.trim();
                    if !v.is_empty() {
                        return Some(v.strip_prefix(['v', 'V']).unwrap_or(v).to_string());
                    }
                }
            }
            None
        }
        Ok(serde_json::Value::String(s)) if !s.trim().is_empty() => {
            Some(s.trim().strip_prefix(['v', 'V']).unwrap_or(s.trim()).into())
        }
        _ => from_text(),
    }
}

/// `0.4.0`, `v2` — digits after an optional `v` prefix, up to a 64-char line.
fn looks_like_version(line: &str) -> bool {
    line.strip_prefix(['v', 'V'])
        .unwrap_or(line)
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
}

/// Shared client for the batch check: short total timeout, checks must feel
/// snappy and failure is a per-plugin error, not a broken download.
fn check_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent("companion-plugin-updater")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// Client for the package download: bounded connect timeout only — a large
/// package may legitimately stream for minutes.
fn download_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent("companion-plugin-updater")
        .connect_timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// Resolve the package URL, stream it with progress events, sanity-check the
/// archive, and hand it to the standard import path (full replace + backend
/// reload + `plugins-changed`).
fn download_and_import(
    state: &PluginHostState,
    plugin_id: &str,
    latest_version: &str,
) -> Result<(), String> {
    // The URL always comes from the plugin's own manifest on disk, never from
    // a frontend argument.
    let info = state
        .list()
        .into_iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
    let template = info
        .update_url
        .ok_or_else(|| format!("{plugin_id} does not declare an updateUrl"))?;
    let version = latest_version.trim();
    let version = version.strip_prefix(['v', 'V']).unwrap_or(version);
    let url = template
        .replace("{version}", version)
        .replace("{platform}", asset_platform());

    let mut resp = download_client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("update download responded with {status}"));
    }
    let total = resp.content_length();
    let mut bytes: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut last_reported = 0u64;
    loop {
        let n = resp
            .read(&mut chunk)
            .map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
        if bytes.len() as u64 - last_reported >= PROGRESS_STEP {
            last_reported = bytes.len() as u64;
            let _ = state.inner.app.emit(
                PROGRESS_EVENT,
                UpdateProgress {
                    plugin_id: plugin_id.into(),
                    received: last_reported,
                    total,
                },
            );
        }
    }
    if bytes.is_empty() {
        return Err("update download was empty".into());
    }

    // The package lands under its own manifest id; make sure an update can't
    // quietly install as (and clobber) a different plugin.
    let archive_id = read_archive_manifest_id(&bytes)?;
    if archive_id != plugin_id {
        return Err(format!(
            "update package is for plugin {archive_id:?}, not {plugin_id:?}"
        ));
    }

    state.import_archive(&bytes).map(|_| ())
}

/// The manifest id inside a downloaded package zip, read without touching
/// disk. Accepts the same layouts import_archive does: `manifest.json` at the
/// zip root or inside a single top-level folder.
fn read_archive_manifest_id(bytes: &[u8]) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("not a valid zip: {e}"))?;
    let mut candidates: Vec<(usize, String)> = zip
        .file_names()
        .filter_map(|name| {
            let parts: Vec<&str> = name.split('/').filter(|s| !s.is_empty()).collect();
            match parts.as_slice() {
                ["manifest.json"] => Some((0usize, name.to_string())),
                [_folder, "manifest.json"] => Some((1, name.to_string())),
                _ => None,
            }
        })
        .collect();
    candidates.sort_by_key(|(depth, _)| *depth);
    for (_, name) in candidates {
        if let Ok(mut file) = zip.by_name(&name) {
            let mut json = String::new();
            if file.read_to_string(&mut json).is_ok() {
                if let Ok(manifest) = PluginManifest::parse(&json) {
                    return Ok(manifest.id);
                }
            }
        }
    }
    Err("update package has no readable manifest.json".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_release_json() {
        let body = r#"{"tag_name":"v0.4.0","name":"x","assets":[]}"#;
        assert_eq!(parse_check_response(body).as_deref(), Some("0.4.0"));
    }

    #[test]
    fn parses_version_field_json() {
        assert_eq!(
            parse_check_response(r#"{"version":"1.2.3"}"#).as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            parse_check_response(r#"{"latest":"9.9.9"}"#),
            None,
            "unknown keys must not be guessed"
        );
    }

    #[test]
    fn parses_bare_json_string() {
        assert_eq!(
            parse_check_response("\"2.0.0\"\n").as_deref(),
            Some("2.0.0")
        );
    }

    #[test]
    fn parses_plain_text() {
        assert_eq!(parse_check_response("0.4.0\n").as_deref(), Some("0.4.0"));
        assert_eq!(
            parse_check_response("v0.4.0\n").as_deref(),
            Some("0.4.0"),
            "v prefix stripped on the text path too"
        );
        // A bare two-segment version parses as a JSON number — must survive
        // via the text fallback.
        assert_eq!(parse_check_response("0.4").as_deref(), Some("0.4"));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse_check_response("   \n\n"), None);
        assert_eq!(
            parse_check_response("{\"other\":true}"),
            None,
            "object without tag_name/version is not a version"
        );
        assert_eq!(
            parse_check_response("<!DOCTYPE html>\n<html>"),
            None,
            "an HTML error page is not a version"
        );
    }

    #[test]
    fn reads_version_from_redirect_tag_path() {
        assert_eq!(
            version_from_tag_path("/companion-lab/companion-plugin-alarms/releases/tag/v0.4.0"),
            Some("0.4.0".into())
        );
        assert_eq!(
            version_from_tag_path("/o/r/releases/tag/1.2.3"),
            Some("1.2.3".into())
        );
        assert_eq!(
            version_from_tag_path("/o/r/releases/latest"),
            None,
            "the un-redirected URL carries no version"
        );
        assert_eq!(
            version_from_tag_path("/o/r/releases/tag/not-a-version"),
            None
        );
    }
}
