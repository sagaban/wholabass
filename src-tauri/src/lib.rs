pub mod ids;
pub mod ipc;
pub mod library;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::ipc::Sidecar;

pub struct AppState {
    pub sidecar: Mutex<Option<Arc<Sidecar>>>,
}

#[derive(Debug, Serialize)]
pub struct PingResult {
    pub ok: bool,
    pub timestamp: f64,
    pub processing_version: u32,
}

#[derive(Debug, Serialize)]
pub struct IngestResult {
    pub song_id: String,
    pub out_dir: String,
    pub stems: Vec<String>,
    pub duration_sec: f64,
    pub cache_hit: bool,
}

#[tauri::command]
async fn ping(state: State<'_, AppState>) -> Result<PingResult, String> {
    let sc = take_sidecar(&state).await?;
    let resp = sc
        .call("ping", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    let timestamp = resp
        .get("timestamp")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "invalid ping response: missing timestamp".to_string())?;
    Ok(PingResult {
        ok: true,
        timestamp,
        processing_version: ids::PROCESSING_VERSION,
    })
}

#[tauri::command]
async fn ingest_file(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<IngestResult, String> {
    let source_path = PathBuf::from(&path);
    if !source_path.is_file() {
        return Err(format!("not a file: {path}"));
    }

    let song_id = ids::song_id_from_file(&source_path).map_err(|e| e.to_string())?;
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    let out_dir =
        library::ensure_song_dir(&library_root, &song_id).map_err(|e| e.to_string())?;

    if library::is_ready(&library_root, &song_id, ids::PROCESSING_VERSION) {
        let meta = library::read_meta(&library_root, &song_id)
            .ok_or_else(|| "is_ready=true but read_meta failed".to_string())?;
        return Ok(IngestResult {
            song_id,
            out_dir: out_dir.display().to_string(),
            stems: library::STEM_NAMES.iter().map(|s| (*s).to_string()).collect(),
            duration_sec: meta.duration,
            cache_hit: true,
        });
    }

    let sc = take_sidecar(&state).await?;
    let resp = sc
        .call(
            "separate",
            serde_json::json!({
                "song_id": song_id,
                "source_path": source_path.to_string_lossy(),
                "out_dir": out_dir.to_string_lossy(),
                "processing_version": ids::PROCESSING_VERSION,
            }),
        )
        .await
        .map_err(|e| e.to_string())?;

    parse_separate_response(&resp, &song_id, &out_dir)
}

#[tauri::command]
async fn read_stem(
    song_id: String,
    stem: String,
    app: AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    let path = library::stem_path(&library_root, &song_id, &stem).map_err(|e| e.to_string())?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn take_sidecar(state: &State<'_, AppState>) -> Result<Arc<Sidecar>, String> {
    // The sidecar is spawned in a background task at startup; give it a moment
    // on first call rather than failing immediately if the user is fast.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sc) = state.sidecar.lock().await.clone() {
            return Ok(sc);
        }
        if std::time::Instant::now() >= deadline {
            return Err("sidecar not started".to_string());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn parse_separate_response(
    resp: &Value,
    song_id: &str,
    out_dir: &std::path::Path,
) -> Result<IngestResult, String> {
    let stems = resp
        .get("stems")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "separate response missing stems[]".to_string())?
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect::<Vec<_>>();
    let duration_sec = resp
        .get("duration_sec")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "separate response missing duration_sec".to_string())?;
    Ok(IngestResult {
        song_id: song_id.to_string(),
        out_dir: out_dir.display().to_string(),
        stems,
        duration_sec,
        cache_hit: false,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sidecar: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match Sidecar::spawn().await {
                    Ok(sc) => {
                        let state = handle.state::<AppState>();
                        *state.sidecar.lock().await = Some(Arc::new(sc));
                    }
                    Err(e) => {
                        eprintln!("failed to spawn sidecar: {e:#}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ping, ingest_file, read_stem])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_separate_response() {
        let resp = serde_json::json!({
            "song_id": "abc",
            "stems": ["vocals", "drums", "bass", "other"],
            "duration_sec": 12.5,
            "samplerate": 44100,
            "channels": 2,
        });
        let out = parse_separate_response(&resp, "abc", std::path::Path::new("/tmp/abc")).unwrap();
        assert_eq!(out.song_id, "abc");
        assert_eq!(out.stems, vec!["vocals", "drums", "bass", "other"]);
        assert_eq!(out.duration_sec, 12.5);
    }

    #[test]
    fn parse_response_rejects_missing_stems() {
        let resp = serde_json::json!({"duration_sec": 1.0});
        assert!(parse_separate_response(&resp, "x", std::path::Path::new("/")).is_err());
    }

    #[test]
    fn parse_response_rejects_missing_duration() {
        let resp = serde_json::json!({"stems": []});
        assert!(parse_separate_response(&resp, "x", std::path::Path::new("/")).is_err());
    }
}
