pub mod ids;
pub mod ipc;

use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};
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

#[tauri::command]
async fn ping(state: State<'_, AppState>) -> Result<PingResult, String> {
    let sidecar = {
        let guard = state.sidecar.lock().await;
        guard.clone()
    };
    let Some(sc) = sidecar else {
        return Err("sidecar not started".to_string());
    };
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
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
