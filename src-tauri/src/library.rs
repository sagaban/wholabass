use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("could not resolve app data dir: {0}")]
    AppDataDir(#[from] tauri::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// `<app_data_dir>/library`.
pub fn resolve_root(app: &AppHandle) -> Result<PathBuf, LibraryError> {
    let base = app.path().app_data_dir()?;
    Ok(base.join("library"))
}

/// `<root>/<id>` (no side effects).
pub fn song_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

/// Ensure `<root>/<id>/` exists; return its path.
pub fn ensure_song_dir(root: &Path, id: &str) -> std::io::Result<PathBuf> {
    let dir = song_dir(root, id);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_dir_is_root_join_id() {
        let root = Path::new("/tmp/wholabass-library");
        assert_eq!(song_dir(root, "abc123"), root.join("abc123"));
    }

    #[test]
    fn ensure_creates_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "wholabass-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = ensure_song_dir(&tmp, "id1").unwrap();
        assert!(dir.is_dir());
        // Idempotent.
        let dir2 = ensure_song_dir(&tmp, "id1").unwrap();
        assert_eq!(dir, dir2);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
