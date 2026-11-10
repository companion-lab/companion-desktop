// Updates from GitHub Releases. The release pipeline (.github/workflows/build.yml)
// publishes plain zipped installers per platform — companion-<version>-<platform>.zip
// — with no signed updater artifacts, so there is no silent auto-update possible.
// This is the manual flow instead: check the Releases API, download the platform
// zip, extract the installer, and hand it to the OS opener (or send the user to
// the releases page).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

// Releases of the project itself (see README / build.yml).
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/companion-lab/companion-desktop/releases/latest";

// Download lifecycle events, emitted app-wide and consumed by the settings
// webview (same pattern as the plugin host's plugins-changed).
const PROGRESS_EVENT: &str = "update-download-progress";
const COMPLETE_EVENT: &str = "update-download-complete";
const FAILED_EVENT: &str = "update-download-failed";

/// Result of checking GitHub for the newest release. Everything beside
/// `current_version`/`is_newer` is optional: a release may lack a matching
/// platform asset, in which case the UI falls back to the releases page link.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub tag_name: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub download_url: Option<String>,
    pub asset_size: Option<u64>,
    pub html_url: String,
    pub is_newer: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadResult {
    installer_path: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

/// Check GitHub for the newest release. Runs on the blocking pool: the HTTP
/// round trip may take as long as it wants (plugin_call's spawn_blocking rule).
#[tauri::command(rename_all = "snake_case")]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || check_latest(&app))
        .await
        .map_err(|e| format!("update check failed: {e}"))?
}

/// Fire-and-forget download of the release zip for `download_url`. Like
/// plugin_import_archive: long-running commands lose their IPC responses on
/// macOS while the webview's scheme task stays open, so the command returns
/// before the work does and the download events signal completion (or failure).
#[tauri::command(rename_all = "snake_case")]
pub fn download_update(
    app: AppHandle,
    download_url: String,
    tag_name: String,
) -> Result<(), String> {
    std::thread::spawn(move || {
        if let Err(e) = download_and_extract(&app, &download_url, &tag_name) {
            eprintln!("[update] download failed: {e}");
            let _ = app.emit(FAILED_EVENT, serde_json::json!({ "message": e }));
        }
    });
    Ok(())
}

/// Hand the downloaded installer to the OS handler (mount the dmg, run the
/// msi/exe, or install the deb).
#[tauri::command(rename_all = "snake_case")]
pub fn open_update_installer(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Open a URL in the user's browser (e.g. the releases page). Invoke handler
/// commands are callable from any webview, so restrict this to http(s).
#[tauri::command(rename_all = "snake_case")]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn check_latest(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".into());
    let release = fetch_latest()?;

    let is_newer = !current.is_empty() && is_newer_version(&current, &release.tag_name);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name.ends_with(&format!("-{}.zip", asset_platform())));

    Ok(UpdateInfo {
        current_version: current,
        latest_version: release.tag_name.strip_prefix(['v', 'V']).map(String::from),
        tag_name: Some(release.tag_name),
        notes: release.body,
        published_at: release.published_at,
        download_url: asset.map(|a| a.browser_download_url.clone()),
        asset_size: asset.map(|a| a.size),
        html_url: release.html_url,
        is_newer,
    })
}

fn fetch_latest() -> Result<Release, String> {
    // GitHub's API rejects requests without a User-Agent.
    let client = reqwest::blocking::Client::builder()
        .user_agent("companion-desktop-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(LATEST_RELEASE_URL)
        .send()
        .map_err(|e| format!("could not reach GitHub: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("GitHub API rate limit reached; try again later".into());
    }
    if !status.is_success() {
        return Err(format!("GitHub responded with {status}"));
    }
    resp.json::<Release>()
        .map_err(|e| format!("unexpected GitHub response: {e}"))
}

/// Platform tag build.yml stamps into asset names (companion-<version>-<platform>.zip).
/// A target without a built asset matches nothing — the caller degrades to the
/// releases page link.
fn asset_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if cfg!(target_arch = "aarch64") {
            "macos-arm64"
        } else {
            "macos-x86_64"
        }
    }
    #[cfg(target_os = "windows")]
    {
        if cfg!(target_arch = "x86_64") {
            "windows-x86_64"
        } else {
            "windows-aarch64"
        }
    }
    #[cfg(target_os = "linux")]
    {
        if cfg!(target_arch = "x86_64") {
            "linux-x86_64"
        } else {
            "linux-aarch64"
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unknown"
    }
}

/// Compare "1.2.3" style versions (optional `v` prefix and `-prerelease`
/// suffix). Numeric segments compare numerically; a prerelease of the same
/// numbers is older than the plain release; two prereleases count as equal.
fn is_newer_version(current: &str, latest: &str) -> bool {
    let (cur_segs, cur_pre) = parse_version(current);
    let (lat_segs, lat_pre) = parse_version(latest);
    let n = cur_segs.len().max(lat_segs.len());
    for i in 0..n {
        let a = cur_segs.get(i).copied().unwrap_or(0);
        let b = lat_segs.get(i).copied().unwrap_or(0);
        if b != a {
            return b > a;
        }
    }
    // Equal numeric core: the stable release outranks its prerelease.
    cur_pre.is_some() && lat_pre.is_none()
}

fn parse_version(s: &str) -> (Vec<u64>, Option<&str>) {
    let trimmed = s.trim().strip_prefix(['v', 'V']).unwrap_or(s.trim());
    let (core, pre) = match trimmed.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (trimmed, None),
    };
    let segs = core
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    (segs, pre)
}

fn download_and_extract(app: &AppHandle, download_url: &str, tag_name: &str) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("companion-desktop-updater")
        .build()
        .map_err(|e| e.to_string())?;

    // Fresh dir per tag so a retry can't mix old and new files (the idiom
    // plugin import uses for its temp root).
    let version_dir = tag_name.trim().strip_prefix(['v', 'V']).unwrap_or(tag_name);
    let root = std::env::temp_dir().join("companion-update").join(version_dir);
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let zip_path = root.join("release.zip");
    let extract_dir = root.join("extracted");
    std::fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    download_zip(&client, download_url, &zip_path, app)?;
    extract_installer(&zip_path, &extract_dir, app)
}

/// Stream the release zip to disk, emitting throttled progress events.
fn download_zip(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &std::path::Path,
    app: &AppHandle,
) -> Result<(), String> {
    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: GitHub responded with {}", resp.status()));
    }
    let total = resp.content_length();
    let file = std::fs::File::create(dest).map_err(|e| format!("could not write download: {e}"))?;
    let mut writer = std::io::BufWriter::new(file);
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    // The webview coalesces fine as long as events stay sparse; emit on a wall
    // clock budget rather than every chunk.
    let mut last_emit = std::time::Instant::now();
    use std::io::{Read, Write};
    loop {
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("could not write download: {e}"))?;
        received += n as u64;
        if total.is_none() || last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    received,
                    total: total.or(Some(received)),
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    writer
        .flush()
        .map_err(|e| format!("could not write download: {e}"))?;
    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress {
            received,
            total: total.or(Some(received)),
        },
    );
    Ok(())
}

/// Extract the zip and pick the installer file out of it. The workflow zips
/// the platform bundler output (dmg / msi+exe / deb+rpm+AppImage); AppImage is
/// deliberately not runnable — "running" it downloads nothing installable.
fn extract_installer(
    zip_path: &std::path::Path,
    extract_dir: &std::path::Path,
    app: &AppHandle,
) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("not a valid zip: {e}"))?;
    zip.extract(extract_dir)
        .map_err(|e| format!("zip extract failed: {e}"))?;

    let installer = find_installer(extract_dir)?;
    let _ = app.emit(
        COMPLETE_EVENT,
        DownloadResult {
            installer_path: installer.to_string_lossy().into_owned(),
        },
    );
    Ok(())
}

/// Installer extensions per platform, in preference order.
fn installer_extensions() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[".dmg", ".pkg"]
    }
    #[cfg(target_os = "windows")]
    {
        &[".exe", ".msi"]
    }
    #[cfg(target_os = "linux")]
    {
        &[".deb", ".rpm"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        &[]
    }
}

fn find_installer(extract_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let exts = installer_extensions();
    let mut files = vec![];
    walk_files(extract_dir, &mut files);
    let mut candidates: Vec<(usize, std::path::PathBuf)> = files
        .into_iter()
        .filter_map(|path| {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e.to_ascii_lowercase()))?;
            exts.iter().position(|want| *want == ext).map(|prio| (prio, path))
        })
        .collect();
    candidates.sort_by_key(|(prio, _)| *prio);
    candidates.into_iter().next().map(|(_, p)| p).ok_or_else(|| {
        format!(
            "no installer ({}?) found in the release zip",
            exts.join(", ")
        )
    })
}

fn walk_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<std::path::PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            walk_files(&path, out);
        } else {
            out.push(path);
        }
    }
}
