use serde::{Deserialize, Serialize};

/// `manifest.json` shipped at the root of every plugin package.
///
/// ```json
/// {
///   "id": "notes",
///   "name": "Notes",
///   "version": "0.1.0",
///   "description": "Scratchpad notes",
///   "abi": 1,
///   "permissions": ["storage", "events", "tools"],
///   "frontend": { "entry": "frontend.js" },
///   "backend": { "library": "libnotes_backend.dylib" },
///   "versionCheckUrl": "https://example.com/notes/latest-version",
///   "updateUrl": "https://example.com/notes/notes-{version}.zip"
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_abi")]
    pub abi: u32,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub frontend: Option<FrontendEntry>,
    #[serde(default)]
    pub backend: Option<BackendEntry>,
    /// Fetched by the settings UI to learn the newest version. Accepted
    /// forms: a GitHub-style `releases/latest` URL whose redirect target
    /// carries the version (`…/releases/tag/v0.4.0` — not API-rate-limited),
    /// GitHub Releases JSON (`tag_name`), a `{"version": "…"}` object, or a
    /// plain text version. Absent = the plugin does not advertise updates.
    #[serde(default)]
    pub version_check_url: Option<String>,
    /// Zip package fetched on update. `{version}` is replaced with the latest
    /// version (v-stripped), `{platform}` with the host's platform tag
    /// (`macos-arm64`, `macos-x86_64`, `windows-x86_64`, `windows-aarch64`,
    /// `linux-x86_64`, `linux-aarch64` — the suffix release asset names carry).
    /// No placeholder = a fixed URL that always serves the newest package.
    #[serde(default)]
    pub update_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrontendEntry {
    /// Bundled ESM file relative to the plugin directory. Must export
    /// `activate(ctx)`.
    pub entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendEntry {
    /// Dynamic library relative to the plugin directory. Platform naming:
    /// `lib<name>.dylib` (macOS), `<name>.dll` (Windows), `lib<name>.so`
    /// (Linux).
    pub library: String,
}

fn default_abi() -> u32 {
    companion_plugin_sdk::ABI_VERSION
}

impl PluginManifest {
    pub fn parse(json: &str) -> Result<Self, String> {
        let manifest: Self = serde_json::from_str(json).map_err(|e| format!("bad manifest: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Non-fatal warning if the backend library's extension doesn't match the
    /// current platform. Returns `Some(msg)` for a mismatch, `None` otherwise.
    /// Used by the host to surface stale/mis-packaged plugins without refusing
    /// to load them (resolve_library_path handles the fallback).
    pub fn platform_warning(&self) -> Option<String> {
        let backend = self.backend.as_ref()?;
        let ext = std::path::Path::new(&backend.library)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let expected = std::env::consts::DLL_EXTENSION;
        if !ext.is_empty() && ext != expected {
            Some(format!(
                "manifest library '{}' has extension '.{}' but this platform expects '.{}'",
                backend.library, ext, expected
            ))
        } else {
            None
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.id.len() > 64 {
            return Err("id must be 1-64 characters".into());
        }
        if !self
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            || !self
                .id
                .chars()
                .next()
                .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                .unwrap_or(false)
            // "__" is the tool-name qualifier separator (`{id}__{tool}`), so
            // ids containing it would produce ambiguous qualified names.
            || self.id.contains("__")
        {
            return Err(format!(
                "id {:?} must be lowercase alphanumeric with - or _ separators",
                self.id
            ));
        }
        if self.name.is_empty() {
            return Err("name must not be empty".into());
        }
        if self.version.is_empty() {
            return Err("version must not be empty".into());
        }
        if self.abi != companion_plugin_sdk::ABI_VERSION {
            return Err(format!(
                "manifest abi {} does not match host abi {}",
                self.abi,
                companion_plugin_sdk::ABI_VERSION
            ));
        }
        for (field, url) in [
            ("versionCheckUrl", self.version_check_url.as_deref()),
            ("updateUrl", self.update_url.as_deref()),
        ] {
            if let Some(url) = url {
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(format!("{field} must be an http(s) URL"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_manifest() {
        let m = PluginManifest::parse(
            r#"{
                "id": "notes",
                "name": "Notes",
                "version": "0.1.0",
                "description": "d",
                "permissions": ["storage"],
                "frontend": { "entry": "frontend.js" },
                "backend": { "library": "libnotes_backend.dylib" }
            }"#,
        )
        .unwrap();
        assert_eq!(m.id, "notes");
        assert_eq!(m.abi, companion_plugin_sdk::ABI_VERSION);
        assert!(m.frontend.is_some());
        assert!(m.backend.is_some());
    }

    #[test]
    fn rejects_bad_ids() {
        for id in ["", "UPPER", "has space", "../escape", "-leading"] {
            let json = format!(
                r#"{{ "id": "{id}", "name": "n", "version": "0.1.0" }}"#
            );
            assert!(PluginManifest::parse(&json).is_err(), "should reject {id:?}");
        }
    }

    #[test]
    fn rejects_wrong_abi() {
        let json = r#"{ "id": "x", "name": "n", "version": "0.1.0", "abi": 999 }"#;
        assert!(PluginManifest::parse(json).is_err());
    }

    #[test]
    fn frontend_and_backend_optional() {
        let json = r#"{ "id": "ui-only", "name": "UI", "version": "0.1.0" }"#;
        let m = PluginManifest::parse(json).unwrap();
        assert!(m.frontend.is_none() && m.backend.is_none());
    }

    #[test]
    fn update_urls_optional_and_parsed() {
        let bare = r#"{ "id": "x", "name": "n", "version": "0.1.0" }"#;
        let m = PluginManifest::parse(bare).unwrap();
        assert!(m.version_check_url.is_none() && m.update_url.is_none());

        let full = r#"{
            "id": "x", "name": "n", "version": "0.1.0",
            "versionCheckUrl": "https://api.github.com/repos/o/x/releases/latest",
            "updateUrl": "https://github.com/o/x/releases/latest/download/x-{version}-{platform}.zip"
        }"#;
        let m = PluginManifest::parse(full).unwrap();
        assert_eq!(
            m.version_check_url.as_deref(),
            Some("https://api.github.com/repos/o/x/releases/latest")
        );
        assert!(m.update_url.as_deref().unwrap().contains("{version}"));
    }

    #[test]
    fn rejects_non_http_urls() {
        for url in ["ftp://host/latest", "/etc/passwd", "javascript:alert(1)"] {
            let json = format!(
                r#"{{ "id": "x", "name": "n", "version": "0.1.0", "versionCheckUrl": "{url}" }}"#
            );
            assert!(PluginManifest::parse(&json).is_err(), "should reject {url:?}");
        }
    }
}
