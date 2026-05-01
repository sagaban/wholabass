use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};
use thiserror::Error;

pub const PROCESSING_VERSION: u32 = 1;

/// Length of the hex-encoded song id (sha256 truncated).
pub const ID_HEX_LEN: usize = 12;
const ID_BYTES: usize = ID_HEX_LEN / 2;

#[derive(Debug, Error)]
pub enum IdError {
    #[error("not a youtube url: {0}")]
    NotYoutube(String),
    #[error("missing video id in url: {0}")]
    MissingVideoId(String),
    #[error("invalid video id: {0:?}")]
    InvalidVideoId(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid url: {0}")]
    Url(#[from] url::ParseError),
}

/// Compute the song id from raw bytes (sha256, first 12 hex chars).
pub fn song_id_from_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(&digest[..ID_BYTES])
}

/// Compute the song id from a file path by streaming its bytes.
pub fn song_id_from_file(path: &Path) -> Result<String, IdError> {
    let mut hasher = Sha256::new();
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(hex::encode(&digest[..ID_BYTES]))
}

/// Compute the song id from a YouTube URL by extracting the video id and hashing it.
pub fn song_id_from_url(raw: &str) -> Result<String, IdError> {
    let video_id = youtube_video_id(raw)?;
    Ok(song_id_from_bytes(video_id.as_bytes()))
}

/// Strip everything except the video id from a YouTube URL. Returns
/// `https://www.youtube.com/watch?v=<id>`.
///
/// We pass this to yt-dlp instead of the raw URL so playlist (`&list=`),
/// radio (`&start_radio=`), and tracking parameters never reach the
/// downloader.
pub fn canonical_youtube_url(raw: &str) -> Result<String, IdError> {
    let id = youtube_video_id(raw)?;
    Ok(format!("https://www.youtube.com/watch?v={id}"))
}

fn youtube_video_id(raw: &str) -> Result<String, IdError> {
    let parsed = url::Url::parse(raw.trim())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| IdError::NotYoutube(raw.to_string()))?
        .to_lowercase();

    let id: Option<String> = if host == "youtu.be" {
        parsed
            .path_segments()
            .and_then(|mut s| s.next())
            .map(|s| s.to_string())
    } else if host == "youtube.com"
        || host == "www.youtube.com"
        || host == "m.youtube.com"
        || host == "music.youtube.com"
    {
        parsed
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.into_owned())
    } else {
        return Err(IdError::NotYoutube(raw.to_string()));
    };

    let id = id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| IdError::MissingVideoId(raw.to_string()))?;

    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(IdError::InvalidVideoId(id));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn id_from_bytes_is_12_hex_chars() {
        let id = song_id_from_bytes(b"hello world");
        assert_eq!(id.len(), ID_HEX_LEN);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn id_from_bytes_is_deterministic() {
        assert_eq!(
            song_id_from_bytes(b"some audio bytes"),
            song_id_from_bytes(b"some audio bytes"),
        );
    }

    #[test]
    fn id_from_bytes_differs_for_different_inputs() {
        assert_ne!(
            song_id_from_bytes(b"input one"),
            song_id_from_bytes(b"input two"),
        );
    }

    #[test]
    fn id_from_file_matches_bytes() {
        let mut tmp = tempfile_in(std::env::temp_dir());
        tmp.write_all(b"audio content").unwrap();
        let path = tmp.path().to_path_buf();
        drop(tmp);
        assert_eq!(
            song_id_from_file(&path).unwrap(),
            song_id_from_bytes(b"audio content"),
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn youtube_watch_url() {
        assert_eq!(
            youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ").unwrap(),
            "dQw4w9WgXcQ"
        );
    }

    #[test]
    fn youtube_watch_url_with_extra_params() {
        assert_eq!(
            youtube_video_id("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42&feature=share").unwrap(),
            "dQw4w9WgXcQ"
        );
    }

    #[test]
    fn youtu_be_short_url() {
        assert_eq!(
            youtube_video_id("https://youtu.be/dQw4w9WgXcQ").unwrap(),
            "dQw4w9WgXcQ"
        );
    }

    #[test]
    fn music_youtube_url() {
        assert_eq!(
            youtube_video_id("https://music.youtube.com/watch?v=dQw4w9WgXcQ").unwrap(),
            "dQw4w9WgXcQ"
        );
    }

    #[test]
    fn rejects_non_youtube() {
        assert!(matches!(
            youtube_video_id("https://vimeo.com/12345"),
            Err(IdError::NotYoutube(_))
        ));
    }

    #[test]
    fn rejects_missing_video_id() {
        assert!(matches!(
            youtube_video_id("https://youtube.com/watch?foo=bar"),
            Err(IdError::MissingVideoId(_))
        ));
    }

    #[test]
    fn rejects_invalid_video_id() {
        assert!(matches!(
            youtube_video_id("https://youtube.com/watch?v=tooshort"),
            Err(IdError::InvalidVideoId(_))
        ));
    }

    #[test]
    fn song_id_from_url_is_stable() {
        let a = song_id_from_url("https://youtube.com/watch?v=dQw4w9WgXcQ&t=10").unwrap();
        let b = song_id_from_url("https://youtu.be/dQw4w9WgXcQ").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn canonical_youtube_url_strips_extras() {
        let url = "https://www.youtube.com/watch?v=Jnq9wPDoDKg&list=RDJnq9wPDoDKg&start_radio=1";
        assert_eq!(
            canonical_youtube_url(url).unwrap(),
            "https://www.youtube.com/watch?v=Jnq9wPDoDKg",
        );
    }

    #[test]
    fn canonical_youtube_url_normalises_short_form() {
        assert_eq!(
            canonical_youtube_url("https://youtu.be/dQw4w9WgXcQ?t=42").unwrap(),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        );
    }

    #[test]
    fn canonical_youtube_url_rejects_invalid() {
        assert!(canonical_youtube_url("https://vimeo.com/12345").is_err());
    }

    // Tiny tempfile helper to avoid pulling in the `tempfile` crate for one test.
    struct Tmp {
        path: std::path::PathBuf,
        file: std::fs::File,
    }
    impl Tmp {
        fn path(&self) -> &Path {
            &self.path
        }
    }
    impl Write for Tmp {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.file.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }
    fn tempfile_in(dir: std::path::PathBuf) -> Tmp {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = dir.join(format!("wholabass-test-{nanos}.bin"));
        let file = std::fs::File::create(&path).unwrap();
        Tmp { path, file }
    }
}
