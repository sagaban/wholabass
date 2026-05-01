//! Integration test: spawn the Python sidecar, send a ping, verify the response.
//!
//! Requires `uv` on PATH. Skipped (with a printed note) if `uv` is missing so
//! we can still run unit tests on a fresh checkout.

use std::path::PathBuf;
use std::time::Duration;

use wholabass_lib::ipc::Sidecar;

fn ml_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace root")
        .join("ml")
}

fn uv_available() -> bool {
    std::process::Command::new("uv")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn ping_roundtrips_through_sidecar() {
    if !uv_available() {
        eprintln!("skipping: `uv` not on PATH");
        return;
    }

    let sc = tokio::time::timeout(Duration::from_secs(30), Sidecar::spawn_in_dir(&ml_dir()))
        .await
        .expect("sidecar spawn timed out")
        .expect("sidecar spawn failed");

    let result = tokio::time::timeout(
        Duration::from_secs(15),
        sc.call("ping", serde_json::json!({})),
    )
    .await
    .expect("ping timed out")
    .expect("ping returned error");

    let ts = result
        .get("timestamp")
        .and_then(|v| v.as_f64())
        .expect("ping result missing timestamp");
    assert!(ts > 0.0, "timestamp should be a positive unix time");
}

#[tokio::test]
async fn unknown_method_returns_error() {
    if !uv_available() {
        eprintln!("skipping: `uv` not on PATH");
        return;
    }

    let sc = Sidecar::spawn_in_dir(&ml_dir())
        .await
        .expect("sidecar spawn failed");

    let err = tokio::time::timeout(
        Duration::from_secs(15),
        sc.call("__no_such_method__", serde_json::json!({})),
    )
    .await
    .expect("call timed out");

    let Err(e) = err else {
        panic!("expected error, got success");
    };
    let msg = format!("{e:#}");
    assert!(msg.contains("unknown_method"), "unexpected error: {msg}");
}
