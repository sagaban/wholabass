use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SourceRef {
    pub kind: String,
    #[serde(rename = "ref")]
    pub source_ref: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Meta {
    pub song_id: String,
    pub title: String,
    pub source: SourceRef,
    pub duration: f64,
    pub processing_version: u32,
    pub created_at: f64,
}

/// Read and parse `<root>/<id>/meta.json`. Returns None if missing or malformed.
pub fn read_meta(root: &Path, id: &str) -> Option<Meta> {
    let path = song_dir(root, id).join("meta.json");
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<Meta>(&bytes).ok()
}

/// True iff every canonical stem WAV is present on disk.
pub fn all_stems_present(root: &Path, id: &str) -> bool {
    STEM_NAMES.iter().all(|n| {
        stem_path(root, id, n)
            .map(|p| p.is_file())
            .unwrap_or(false)
    })
}

/// True iff the cache for `id` is complete and matches the current
/// processing version. Used to short-circuit the Demucs pipeline.
pub fn is_ready(root: &Path, id: &str, processing_version: u32) -> bool {
    let Some(meta) = read_meta(root, id) else {
        return false;
    };
    if meta.processing_version != processing_version {
        return false;
    }
    all_stems_present(root, id)
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

    fn fresh_temp_root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "wholabass-cache-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Lays down a complete cache entry for `id` with the given processing version.
    fn write_complete_cache(root: &Path, id: &str, version: u32) {
        let song = ensure_song_dir(root, id).unwrap();
        std::fs::create_dir_all(song.join("stems")).unwrap();
        for name in STEM_NAMES {
            std::fs::write(stem_path(root, id, name).unwrap(), b"riff").unwrap();
        }
        let meta = format!(
            r#"{{
  "song_id": "{id}",
  "title": "fixture",
  "source": {{"kind": "file", "ref": "/tmp/x.mp3"}},
  "duration": 12.34,
  "processing_version": {version},
  "created_at": 1.0
}}"#
        );
        std::fs::write(song.join("meta.json"), meta).unwrap();
    }

    #[test]
    fn is_ready_false_when_meta_missing() {
        let root = fresh_temp_root();
        ensure_song_dir(&root, "abc").unwrap();
        assert!(!is_ready(&root, "abc", 1));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn is_ready_false_when_a_stem_missing() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abc", 1);
        std::fs::remove_file(stem_path(&root, "abc", "bass").unwrap()).unwrap();
        assert!(!is_ready(&root, "abc", 1));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn is_ready_false_when_processing_version_differs() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abc", 1);
        assert!(!is_ready(&root, "abc", 2));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn is_ready_true_when_meta_and_all_stems_present_and_version_matches() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abc", 1);
        assert!(is_ready(&root, "abc", 1));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_meta_returns_none_for_malformed_json() {
        let root = fresh_temp_root();
        let song = ensure_song_dir(&root, "x").unwrap();
        std::fs::write(song.join("meta.json"), b"not json").unwrap();
        assert!(read_meta(&root, "x").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_meta_parses_canonical_shape() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abc", 7);
        let meta = read_meta(&root, "abc").expect("meta should parse");
        assert_eq!(meta.song_id, "abc");
        assert_eq!(meta.processing_version, 7);
        assert_eq!(meta.source.kind, "file");
        assert!((meta.duration - 12.34).abs() < 1e-9);
        std::fs::remove_dir_all(&root).ok();
    }
}
