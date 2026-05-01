use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("could not resolve app data dir: {0}")]
    AppDataDir(#[from] tauri::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid stem name: {0}")]
    InvalidStem(String),
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

pub const STEM_NAMES: &[&str] = &["vocals", "drums", "bass", "other"];

/// `<root>/<id>/stems/<name>.wav`. Returns Err if `name` isn't canonical.
pub fn stem_path(root: &Path, id: &str, name: &str) -> Result<PathBuf, LibraryError> {
    if !STEM_NAMES.contains(&name) {
        return Err(LibraryError::InvalidStem(name.to_string()));
    }
    Ok(song_dir(root, id).join("stems").join(format!("{name}.wav")))
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
    fn stem_path_canonical() {
        let root = Path::new("/lib");
        assert_eq!(
            stem_path(root, "abc", "bass").unwrap(),
            root.join("abc").join("stems").join("bass.wav"),
        );
    }

    #[test]
    fn stem_path_rejects_unknown() {
        let root = Path::new("/lib");
        assert!(matches!(
            stem_path(root, "abc", "guitar"),
            Err(LibraryError::InvalidStem(_)),
        ));
    }

    #[test]
    fn stem_path_rejects_traversal() {
        // ".." isn't in STEM_NAMES so it must be rejected, preventing path
        // escape into ../../../etc/whatever.
        let root = Path::new("/lib");
        assert!(stem_path(root, "abc", "../etc/passwd").is_err());
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
