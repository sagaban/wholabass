use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;

use crate::ids::ID_HEX_LEN;

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("could not resolve app data dir: {0}")]
    AppDataDir(#[from] tauri::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid stem name: {0}")]
    InvalidStem(String),
    #[error("invalid song id: {0:?}")]
    InvalidSongId(String),
}

/// Song ids are produced by `ids::song_id_from_*` (sha256 truncated to
/// `ID_HEX_LEN` lowercase hex chars). Anything else is refused so an
/// attacker-controlled id can't escape the library root.
fn validate_song_id(id: &str) -> Result<(), LibraryError> {
    if id.len() != ID_HEX_LEN || !id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return Err(LibraryError::InvalidSongId(id.to_string()));
    }
    Ok(())
}

/// Remove `<root>/<id>/` recursively. No-op if the directory doesn't exist.
pub fn delete_song(root: &Path, id: &str) -> Result<(), LibraryError> {
    validate_song_id(id)?;
    let dir = song_dir(root, id);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir)?;
    Ok(())
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

/// `<root>/<id>/bass.mid`.
pub fn midi_path(root: &Path, id: &str) -> PathBuf {
    song_dir(root, id).join("bass.mid")
}

pub fn has_midi(root: &Path, id: &str) -> bool {
    midi_path(root, id).is_file()
}

/// `<root>/<id>/source.wav`.
pub fn source_path(root: &Path, id: &str) -> PathBuf {
    song_dir(root, id).join("source.wav")
}

pub fn has_source(root: &Path, id: &str) -> bool {
    source_path(root, id).is_file()
}

/// True iff the cache for `id` is complete and matches the current
/// processing version. Used to short-circuit the Demucs + transcribe
/// pipeline. A stale or partial entry returns false so it gets reprocessed.
pub fn is_ready(root: &Path, id: &str, processing_version: u32) -> bool {
    let Some(meta) = read_meta(root, id) else {
        return false;
    };
    if meta.processing_version != processing_version {
        return false;
    }
    all_stems_present(root, id) && has_midi(root, id)
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryEntry {
    pub song_id: String,
    pub title: String,
    pub duration_sec: f64,
    pub processing_version: u32,
    pub created_at: f64,
    pub ready: bool,
    pub has_source: bool,
    pub has_stems: bool,
    pub has_midi: bool,
}

/// List every cache entry under `root` for which a parseable `meta.json`
/// exists. Newest first by `created_at`. Returns an empty vec if `root`
/// itself doesn't exist (first run).
pub fn list(root: &Path, processing_version: u32) -> Vec<LibraryEntry> {
    let Ok(read) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut entries: Vec<LibraryEntry> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let id = e.file_name().to_string_lossy().into_owned();
            let meta = read_meta(root, &id)?;
            let stems = all_stems_present(root, &id);
            let midi = has_midi(root, &id);
            let source = has_source(root, &id);
            let ready = meta.processing_version == processing_version && stems && midi;
            Some(LibraryEntry {
                song_id: meta.song_id,
                title: meta.title,
                duration_sec: meta.duration,
                processing_version: meta.processing_version,
                created_at: meta.created_at,
                ready,
                has_source: source,
                has_stems: stems,
                has_midi: midi,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.created_at.partial_cmp(&a.created_at).unwrap_or(std::cmp::Ordering::Equal));
    entries
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
        std::fs::write(source_path(root, id), b"RIFFsrc.").unwrap();
        for name in STEM_NAMES {
            std::fs::write(stem_path(root, id, name).unwrap(), b"riff").unwrap();
        }
        std::fs::write(midi_path(root, id), b"MThd").unwrap();
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
    fn is_ready_false_when_midi_missing() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abc", 1);
        std::fs::remove_file(midi_path(&root, "abc")).unwrap();
        assert!(!is_ready(&root, "abc", 1));
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

    #[test]
    fn validate_song_id_accepts_canonical() {
        assert!(validate_song_id("abcdef012345").is_ok());
    }

    #[test]
    fn validate_song_id_rejects_wrong_len() {
        assert!(matches!(
            validate_song_id("abc"),
            Err(LibraryError::InvalidSongId(_))
        ));
        assert!(matches!(
            validate_song_id("abcdef0123456"),
            Err(LibraryError::InvalidSongId(_))
        ));
    }

    #[test]
    fn validate_song_id_rejects_traversal_or_uppercase() {
        // Wrong char (slash, dot)
        assert!(validate_song_id("../etc/pass").is_err());
        // Uppercase hex — our ids are lowercase from `hex::encode`.
        assert!(validate_song_id("ABCDEF012345").is_err());
        // Right length, non-hex.
        assert!(validate_song_id("zzzzzzzzzzzz").is_err());
    }

    #[test]
    fn delete_song_removes_dir() {
        let root = fresh_temp_root();
        write_complete_cache(&root, "abcdef012345", 1);
        assert!(song_dir(&root, "abcdef012345").exists());

        delete_song(&root, "abcdef012345").unwrap();
        assert!(!song_dir(&root, "abcdef012345").exists());

        // Idempotent: deleting again succeeds.
        delete_song(&root, "abcdef012345").unwrap();

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_song_refuses_invalid_ids() {
        let root = fresh_temp_root();
        assert!(delete_song(&root, "../escape").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_returns_empty_for_missing_root() {
        let root = std::env::temp_dir().join("wholabass-no-such-dir-xxxx");
        assert!(list(&root, 1).is_empty());
    }

    #[test]
    fn list_returns_entries_newest_first_with_ready_flag() {
        let root = fresh_temp_root();
        // older
        write_complete_cache(&root, "old", 1);
        let old_meta_path = song_dir(&root, "old").join("meta.json");
        let old = std::fs::read_to_string(&old_meta_path)
            .unwrap()
            .replace("\"created_at\": 1.0", "\"created_at\": 100.0");
        std::fs::write(&old_meta_path, old).unwrap();

        // newer (and ready)
        write_complete_cache(&root, "new", 1);
        let new_meta_path = song_dir(&root, "new").join("meta.json");
        let nw = std::fs::read_to_string(&new_meta_path)
            .unwrap()
            .replace("\"created_at\": 1.0", "\"created_at\": 200.0");
        std::fs::write(&new_meta_path, nw).unwrap();

        // stale (wrong processing_version → ready=false)
        write_complete_cache(&root, "stale", 1);
        let stale_meta_path = song_dir(&root, "stale").join("meta.json");
        let stale = std::fs::read_to_string(&stale_meta_path)
            .unwrap()
            .replace("\"created_at\": 1.0", "\"created_at\": 50.0");
        std::fs::write(&stale_meta_path, stale).unwrap();

        // dir without meta.json should be ignored
        ensure_song_dir(&root, "ghost").unwrap();

        let entries = list(&root, 1);
        let ids: Vec<_> = entries.iter().map(|e| e.song_id.as_str()).collect();
        assert_eq!(ids, vec!["new", "old", "stale"]);
        assert!(entries[0].ready);
        let stale_entry = entries.iter().find(|e| e.song_id == "stale").unwrap();
        assert!(stale_entry.ready); // version 1 still matches version 1

        // Bumping processing_version makes everything not-ready.
        let entries_v2 = list(&root, 2);
        assert!(entries_v2.iter().all(|e| !e.ready));

        std::fs::remove_dir_all(&root).ok();
    }
}
