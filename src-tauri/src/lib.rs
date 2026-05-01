pub mod ids;
pub mod ipc;
pub mod library;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::ipc::Sidecar;

pub struct AppState {
    pub sidecar: Mutex<Option<Arc<Sidecar>>>,
    pub current_ingest: Mutex<Option<String>>,
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
    pub title: String,
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
            title: meta.title,
            out_dir: out_dir.display().to_string(),
            stems: library::STEM_NAMES.iter().map(|s| (*s).to_string()).collect(),
            duration_sec: meta.duration,
            cache_hit: true,
        });
    }

    *state.current_ingest.lock().await = Some(song_id.clone());
    let result = run_separate(&state, &app, &song_id, &source_path, &out_dir, None).await;
    *state.current_ingest.lock().await = None;
    result
}

async fn run_separate(
    state: &State<'_, AppState>,
    app: &AppHandle,
    song_id: &str,
    source_path: &std::path::Path,
    out_dir: &std::path::Path,
    title: Option<&str>,
) -> Result<IngestResult, String> {
    let sc = take_sidecar(state).await?;
    let app_emit = app.clone();
    let mut params = serde_json::json!({
        "song_id": song_id,
        "source_path": source_path.to_string_lossy(),
        "out_dir": out_dir.to_string_lossy(),
        "processing_version": ids::PROCESSING_VERSION,
    });
    if let Some(t) = title {
        params["title"] = serde_json::Value::String(t.to_string());
    }
    let resp = sc
        .call_with_progress("separate", params, |progress, stage| {
            emit_progress(&app_emit, progress, stage)
        })
        .await
        .map_err(|e| e.to_string())?;

    // Chain bass MIDI transcription. Errors here surface to the user but
    // don't roll back stems — the user can retry.
    let bass_path = out_dir.join("stems").join("bass.wav");
    sc.call_with_progress(
        "transcribe",
        serde_json::json!({
            "song_id": song_id,
            "bass_path": bass_path.to_string_lossy(),
            "out_dir": out_dir.to_string_lossy(),
        }),
        |progress, stage| emit_progress(&app_emit, progress, stage),
    )
    .await
    .map_err(|e| format!("transcribe: {e}"))?;

    parse_separate_response(&resp, song_id, out_dir)
}

#[tauri::command]
async fn ingest_url(
    url: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<IngestResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".to_string());
    }

    // Validating the URL up front means an invalid input never creates a
    // half-written library/<id>/ directory. We also strip query params
    // (playlist, start_radio, tracking) by passing the canonical
    // single-video URL to yt-dlp so it never picks up a playlist.
    let song_id = ids::song_id_from_url(&url).map_err(|e| e.to_string())?;
    let url = ids::canonical_youtube_url(&url).map_err(|e| e.to_string())?;
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;

    if library::is_ready(&library_root, &song_id, ids::PROCESSING_VERSION) {
        let meta = library::read_meta(&library_root, &song_id)
            .ok_or_else(|| "is_ready=true but read_meta failed".to_string())?;
        let out_dir = library::song_dir(&library_root, &song_id);
        return Ok(IngestResult {
            song_id,
            title: meta.title,
            out_dir: out_dir.display().to_string(),
            stems: library::STEM_NAMES.iter().map(|s| (*s).to_string()).collect(),
            duration_sec: meta.duration,
            cache_hit: true,
        });
    }

    let out_dir =
        library::ensure_song_dir(&library_root, &song_id).map_err(|e| e.to_string())?;

    *state.current_ingest.lock().await = Some(song_id.clone());
    let result = run_download_and_separate(&state, &app, &song_id, &url, &out_dir).await;
    *state.current_ingest.lock().await = None;
    result
}

async fn run_download_and_separate(
    state: &State<'_, AppState>,
    app: &AppHandle,
    song_id: &str,
    url: &str,
    out_dir: &std::path::Path,
) -> Result<IngestResult, String> {
    let sc = take_sidecar(state).await?;
    let app_emit = app.clone();

    let download_resp = sc
        .call_with_progress(
            "download",
            serde_json::json!({
                "song_id": song_id,
                "url": url,
                "out_dir": out_dir.to_string_lossy(),
            }),
            |progress, stage| emit_progress(&app_emit, progress, stage),
        )
        .await
        .map_err(|e| format!("download: {e}"))?;

    let title = download_resp
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let source_path = out_dir.join("source.wav");
    run_separate(state, app, song_id, &source_path, out_dir, title.as_deref()).await
}

fn emit_progress(app: &AppHandle, progress: f64, stage: &str) {
    let _ = app.emit(
        "ingest:progress",
        serde_json::json!({ "progress": progress, "stage": stage }),
    );
}

#[tauri::command]
async fn list_library(app: AppHandle) -> Result<Vec<library::LibraryEntry>, String> {
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    Ok(library::list(&library_root, ids::PROCESSING_VERSION))
}

#[tauri::command]
async fn retry_song(
    song_id: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<IngestResult, String> {
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    let out_dir = library::song_dir(&library_root, &song_id);
    if !out_dir.is_dir() {
        return Err(format!("nothing to retry for {song_id}"));
    }

    let stems = library::all_stems_present(&library_root, &song_id);
    let midi = library::has_midi(&library_root, &song_id);
    let source = library::has_source(&library_root, &song_id);

    if stems && midi {
        // Already complete — return the cached IngestResult.
        let meta = library::read_meta(&library_root, &song_id)
            .ok_or_else(|| "stems + midi present but meta missing".to_string())?;
        return Ok(IngestResult {
            song_id: song_id.clone(),
            title: meta.title,
            out_dir: out_dir.display().to_string(),
            stems: library::STEM_NAMES.iter().map(|s| (*s).to_string()).collect(),
            duration_sec: meta.duration,
            cache_hit: true,
        });
    }

    if !source {
        return Err(format!(
            "source.wav missing for {song_id}; please re-ingest from scratch"
        ));
    }

    let _ = midi; // already inferred via the `stems && midi` branch above.

    *state.current_ingest.lock().await = Some(song_id.clone());
    let result = run_retry(&state, &app, &song_id, &out_dir, stems).await;
    *state.current_ingest.lock().await = None;
    result
}

async fn run_retry(
    state: &State<'_, AppState>,
    app: &AppHandle,
    song_id: &str,
    out_dir: &std::path::Path,
    stems: bool,
) -> Result<IngestResult, String> {
    let library_root = out_dir
        .parent()
        .ok_or_else(|| "song dir has no parent".to_string())?;
    let source_path = out_dir.join("source.wav");

    if !stems {
        // Source exists but stems don't — resume at separate. run_separate
        // chains transcribe so we end up complete.
        let title = library::read_meta(library_root, song_id).map(|m| m.title);
        return run_separate(state, app, song_id, &source_path, out_dir, title.as_deref()).await;
    }

    // Stems already present, only MIDI is missing — run transcribe alone.
    let sc = take_sidecar(state).await?;
    let app_emit = app.clone();
    let bass_path = out_dir.join("stems").join("bass.wav");
    sc.call_with_progress(
        "transcribe",
        serde_json::json!({
            "song_id": song_id,
            "bass_path": bass_path.to_string_lossy(),
            "out_dir": out_dir.to_string_lossy(),
        }),
        |progress, stage| emit_progress(&app_emit, progress, stage),
    )
    .await
    .map_err(|e| format!("transcribe: {e}"))?;

    let meta = library::read_meta(library_root, song_id)
        .ok_or_else(|| "post-retry meta missing".to_string())?;
    Ok(IngestResult {
        song_id: song_id.to_string(),
        title: meta.title,
        out_dir: out_dir.display().to_string(),
        stems: library::STEM_NAMES.iter().map(|s| (*s).to_string()).collect(),
        duration_sec: meta.duration,
        cache_hit: false,
    })
}

#[tauri::command]
async fn delete_song(song_id: String, app: AppHandle) -> Result<(), String> {
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    library::delete_song(&library_root, &song_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_ingest(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let song_id = state.current_ingest.lock().await.take();

    // Kill the running sidecar (if any). The in-flight ingest_* command
    // sees its IPC call fail and returns an error to the frontend.
    let old = state.sidecar.lock().await.take();
    if let Some(sc) = &old {
        sc.kill_child().await;
    }
    drop(old);

    // Spawn a fresh sidecar so the next ingest works.
    match Sidecar::spawn().await {
        Ok(sc) => {
            *state.sidecar.lock().await = Some(Arc::new(sc));
        }
        Err(e) => eprintln!("respawn sidecar after cancel: {e:#}"),
    }

    // Best-effort cleanup of the partial library entry.
    if let Some(id) = &song_id {
        if let Ok(library_root) = library::resolve_root(&app) {
            let _ = library::delete_song(&library_root, id);
        }
    }
    Ok(song_id)
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

#[tauri::command]
async fn read_midi(song_id: String, app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let library_root = library::resolve_root(&app).map_err(|e| e.to_string())?;
    let path = library::midi_path(&library_root, &song_id);
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
    let title = resp
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(song_id)
        .to_string();
    Ok(IngestResult {
        song_id: song_id.to_string(),
        title,
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
            current_ingest: Mutex::new(None),
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
        .invoke_handler(tauri::generate_handler![
            ping,
            ingest_file,
            ingest_url,
            cancel_ingest,
            retry_song,
            list_library,
            delete_song,
            read_stem,
            read_midi
        ])
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
