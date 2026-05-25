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
    /// Spawn the sidecar, preferring the bundled binary in a packaged
    /// build and falling back to `uv run python server.py` when running
    /// from a dev checkout.
    ///
    /// In a Tauri bundle the PyInstaller-compiled `wholabass-server`
    /// binary lives in the app's resource dir alongside a static
    /// `ffmpeg` (both shipped via `bundle.externalBin`). We export
    /// `FFMPEG_LOCATION` so `yt-dlp` finds the sibling binary without
    /// needing a system install. The dev fallback exists so
    /// `pnpm tauri dev` keeps working without first running the
    /// 1-2 minute PyInstaller build.
    pub async fn spawn(app: &tauri::AppHandle) -> Result<Self> {
        if let Some(packaged) = locate_bundled_sidecar(app) {
            return Self::spawn_bundled(&packaged.binary, packaged.ffmpeg.as_deref()).await;
        }
        let project_root = locate_project_root()
            .context("could not locate project root containing ml/server.py")?;
        Self::spawn_in_dir(&project_root.join("ml")).await
    }

    /// Direct-spawn the bundled binary (no `uv` involvement). Used in
    /// production where there's no Python install on the user's
    /// machine — the PyInstaller binary is self-contained.
    async fn spawn_bundled(binary: &std::path::Path, ffmpeg: Option<&std::path::Path>) -> Result<Self> {
        let mut cmd = Command::new(binary);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(ff) = ffmpeg {
            cmd.env("FFMPEG_LOCATION", ff);
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn bundled sidecar at {}", binary.display()))?;

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
        self.call_with_progress(method, params, |_, _| {}).await
    }

    /// Like `call`, but also forwards each `{progress, stage}` event the
    /// sidecar emits for this request to `on_progress`. The closure runs
    /// inline on the IO task — keep it cheap (e.g. `app.emit(...)`).
    pub async fn call_with_progress<F>(
        &self,
        method: &str,
        params: Value,
        on_progress: F,
    ) -> Result<Value>
    where
        F: Fn(f64, &str),
    {
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
            // Ignore events with mismatched ids — they belong to other requests.
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
            if let Some(progress) = value.get("progress").and_then(|v| v.as_f64()) {
                let stage = value.get("stage").and_then(|v| v.as_str()).unwrap_or("");
                on_progress(progress, stage);
                continue;
            }
            bail!("malformed sidecar response: {value}");
        }
    }

    /// Forcibly terminate the child process. After this returns the
    /// sidecar is unusable — the caller should drop it and spawn a new one.
    pub async fn kill_child(&self) {
        let mut inner = self.inner.lock().await;
        let _ = inner.child.start_kill();
        let _ = inner.child.wait().await;
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

struct BundledSidecar {
    binary: std::path::PathBuf,
    ffmpeg: Option<std::path::PathBuf>,
}

/// Look for the PyInstaller-compiled sidecar that ships next to the
/// main binary in the Tauri bundle. On macOS, `bundle.externalBin`
/// entries land in `Wholabass.app/Contents/MacOS/` alongside the main
/// executable — *not* in `Contents/Resources/`, which is what
/// `app.path().resource_dir()` returns. Resolving via the current
/// executable's parent dir works for all three desktop platforms
/// (Tauri puts the sibling files there on Linux + Windows too).
///
/// Returns `None` in a dev checkout where the binary isn't actually
/// next to the dev executable — the caller falls back to `uv run`.
fn locate_bundled_sidecar(_app: &tauri::AppHandle) -> Option<BundledSidecar> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let binary = dir.join(format!("wholabass-server{suffix}"));
    if !binary.is_file() {
        return None;
    }
    let ffmpeg_path = dir.join(format!("ffmpeg{suffix}"));
    let ffmpeg = ffmpeg_path.is_file().then_some(ffmpeg_path);
    Some(BundledSidecar { binary, ffmpeg })
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
