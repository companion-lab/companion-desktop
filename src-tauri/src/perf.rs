use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoadMode {
    Eager,
    Lazy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FpsCap {
    Thirty,
    Sixty,
    Uncapped,
}

impl FpsCap {
    #[allow(dead_code)]
    pub fn as_fps(self) -> Option<f32> {
        match self {
            FpsCap::Thirty => Some(30.0),
            FpsCap::Sixty => Some(60.0),
            FpsCap::Uncapped => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PerformanceConfig {
    pub load_mode: LoadMode,
    pub tts_threads: usize,
    pub unload_stt_when_idle: bool,
    pub max_pixel_ratio: f32,
    pub fps_cap: FpsCap,
    pub antialias: bool,
}

impl Default for PerformanceConfig {
    fn default() -> Self {
        PerformanceConfig {
            load_mode: LoadMode::Eager,
            tts_threads: 0,
            unload_stt_when_idle: true,
            max_pixel_ratio: 1.5,
            fps_cap: FpsCap::Sixty,
            antialias: true,
        }
    }
}

pub struct PerfState {
    pub config: Mutex<PerformanceConfig>,
}

impl PerfState {
    fn new(config: PerformanceConfig) -> Self {
        PerfState {
            config: Mutex::new(config),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join("performance.json"))
}

pub fn read_config(app: &tauri::AppHandle) -> PerformanceConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return PerformanceConfig::default(),
    };
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => PerformanceConfig::default(),
    }
}

fn write_config(app: &tauri::AppHandle, config: &PerformanceConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("write config: {e}"))
}

pub fn init_state(config: PerformanceConfig) -> PerfState {
    PerfState::new(config)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_performance_config(state: tauri::State<'_, PerfState>) -> Result<PerformanceConfig, String> {
    state.config.lock().map(|c| *c).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn set_performance_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, PerfState>,
    config: PerformanceConfig,
) -> Result<PerformanceConfig, String> {
    write_config(&app, &config)?;
    let mut guard = state.config.lock().map_err(|e| e.to_string())?;
    *guard = config;
    drop(guard);
    let _ = app.emit("perf-changed", config);
    Ok(config)
}

