use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Long-running Python sidecar with newline-JSON-RPC over stdio.
///
/// Calls are serialized through a single mutex; T0 only needs `ping` and
/// concurrent calls aren't required yet. When that changes, replace this
/// with a dispatch loop + per-request oneshot channels.
pub struct Sidecar {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
}

struct Inner {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Sidecar {
    pub async fn spawn() -> Result<Self> {
        let project_root = locate_project_root()
            .context("could not locate project root containing ml/server.py")?;
        Self::spawn_in_dir(&project_root.join("ml")).await
    }

    pub async fn spawn_in_dir(ml_dir: &std::path::Path) -> Result<Self> {
        if !ml_dir.join("server.py").exists() {
            bail!("ml/server.py not found at {}", ml_dir.display());
        }

        let mut child = Command::new("uv")
            .arg("run")
            .arg("--quiet")
            .arg("python")
            .arg("server.py")
            .current_dir(ml_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("failed to spawn `uv run python server.py`")?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no child stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no child stdout"))?;

        Ok(Self {
            inner: Mutex::new(Inner {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            }),
            next_id: AtomicU64::new(1),
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let req = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');

        let mut inner = self.inner.lock().await;
        inner
            .stdin
            .write_all(line.as_bytes())
            .await
            .context("write request to sidecar")?;
        inner.stdin.flush().await.ok();

        loop {
            let mut buf = String::new();
            let n = inner
                .stdout
                .read_line(&mut buf)
                .await
                .context("read response from sidecar")?;
            if n == 0 {
                bail!("sidecar closed stdout");
            }
            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)
                .with_context(|| format!("parse sidecar response: {trimmed}"))?;
            // Ignore progress events with mismatched ids — we only care about result/error here.
            let resp_id = value.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if resp_id != id {
                continue;
            }
            if let Some(err) = value.get("error") {
                bail!("sidecar error: {err}");
            }
            if let Some(result) = value.get("result") {
                return Ok(result.clone());
            }
            // Progress event for this id — keep reading.
            if value.get("progress").is_some() {
                continue;
            }
            bail!("malformed sidecar response: {value}");
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        // tokio Child is `kill_on_drop`, but explicit best-effort kill ensures the
        // sidecar is gone even if the runtime is shutting down oddly.
        if let Ok(mut inner) = self.inner.try_lock() {
            let _ = inner.child.start_kill();
        }
    }
}

/// Walk up from CARGO_MANIFEST_DIR or the current exe to find the project root
/// (the directory containing `ml/server.py`).
fn locate_project_root() -> Result<std::path::PathBuf> {
    // In dev (`cargo run` / `tauri dev`), CARGO_MANIFEST_DIR points to src-tauri.
    if let Some(dir) = option_env!("CARGO_MANIFEST_DIR") {
        let candidate = std::path::Path::new(dir)
            .parent()
            .map(|p| p.to_path_buf());
        if let Some(p) = candidate {
            if p.join("ml/server.py").exists() {
                return Ok(p);
            }
        }
    }

    // In a packaged build, look near the executable. Walk upwards a few levels.
    let exe = std::env::current_exe().context("get current exe path")?;
    let mut cur = exe.as_path();
    for _ in 0..6 {
        if let Some(parent) = cur.parent() {
            if parent.join("ml/server.py").exists() {
                return Ok(parent.to_path_buf());
            }
            cur = parent;
        } else {
            break;
        }
    }

    bail!("project root not found")
}
