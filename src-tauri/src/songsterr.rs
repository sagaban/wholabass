//! Songsterr URL → bass-track revision JSON.
//!
//! Pipeline:
//!  1. GET the public song page with a browser-like User-Agent. Songsterr's
//!     HTML embeds a `<script id="state">{...}</script>` blob carrying the
//!     full song metadata.
//!  2. Extract + parse that JSON. We only need `meta.current`.
//!  3. Pick the first bass-like track (auto-pick per the user's spec).
//!  4. Fetch the per-track revision JSON from Songsterr's CDN, falling back
//!     to a known alternate host when the primary returns nothing.
//!
//! The conversion (alphaTab → GP7) lives in the frontend — alphaTab is a
//! TS-only library. This module is purely the data-fetching shim.
//!
//! Approach + types ported from
//! https://github.com/Metaphysics0/songsterr-downloader (MIT). The page
//! payload + CDN URL shapes are Songsterr's, not a public API; we may
//! need to revisit if they change shape.

use serde::{Deserialize, Serialize};

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";

const CDN_PRIMARY: &str = "https://dqsljvtekg760.cloudfront.net";
const CDN_FALLBACK: &str = "https://d3d3l6a6rcgkaf.cloudfront.net";

/// The raw bass-track payload, ready to feed into alphaTab on the frontend.
#[derive(Serialize, Deserialize, Debug)]
pub struct SongsterrBassResult {
    pub title: String,
    pub artist: String,
    pub song_id: u64,
    pub revision_id: u64,
    pub image: String,
    pub track: SongsterrTrackMeta,
    /// Raw revision JSON for the bass track. Passed through to alphaTab.
    pub revision: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SongsterrTrackMeta {
    #[serde(rename = "partId")]
    pub part_id: u64,
    #[serde(rename = "trackId", default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub instrument: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum SongsterrError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("page payload missing or malformed: {0}")]
    PageParse(String),
    #[error("no bass track found in song")]
    NoBassTrack,
    #[error("revision fetch failed: {0}")]
    RevisionFetch(String),
}

/// Public entry point: take a Songsterr song URL, return the bass track's
/// revision payload + metadata.
pub async fn fetch_bass(url: &str) -> Result<SongsterrBassResult, SongsterrError> {
    let client = build_client()?;
    let html = fetch_html(&client, url).await?;
    let meta = extract_state_meta(&html)?;
    let bass = pick_bass_track(&meta.tracks).ok_or(SongsterrError::NoBassTrack)?.clone();
    let revision = fetch_revision(&client, &meta, &bass).await?;
    Ok(SongsterrBassResult {
        title: meta.title,
        artist: meta.artist,
        song_id: meta.song_id,
        revision_id: meta.revision_id,
        image: meta.image,
        track: bass,
        revision,
    })
}

fn build_client() -> Result<reqwest::Client, SongsterrError> {
    Ok(reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .gzip(true)
        .build()?)
}

async fn fetch_html(client: &reqwest::Client, url: &str) -> Result<String, SongsterrError> {
    Ok(client.get(url).send().await?.error_for_status()?.text().await?)
}

/// Minimal projection of Songsterr's `state.meta.current` payload — only
/// what we need to find + fetch the bass revision.
#[derive(Debug)]
struct StateMeta {
    song_id: u64,
    revision_id: u64,
    image: String,
    title: String,
    artist: String,
    tracks: Vec<SongsterrTrackMeta>,
}

fn extract_state_meta(html: &str) -> Result<StateMeta, SongsterrError> {
    // The page's state script lives at `<script id="state">…</script>`. The
    // body is plain JSON. Pull the script's text content with a permissive
    // regex (DOTALL, non-greedy) so newlines inside the JSON don't break us.
    let re = regex::Regex::new(r#"(?s)<script[^>]*id="state"[^>]*>(.*?)</script>"#)
        .map_err(|e| SongsterrError::PageParse(e.to_string()))?;
    let caps = re
        .captures(html)
        .ok_or_else(|| SongsterrError::PageParse("no <script id=\"state\"> tag".into()))?;
    let raw = caps.get(1).unwrap().as_str();
    let v: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| SongsterrError::PageParse(format!("state JSON parse: {e}")))?;
    let current = v
        .pointer("/meta/current")
        .ok_or_else(|| SongsterrError::PageParse("missing meta.current".into()))?;

    let song_id = current
        .get("songId")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| SongsterrError::PageParse("missing songId".into()))?;
    let revision_id = current
        .get("revisionId")
        .and_then(|x| x.as_u64())
        .ok_or_else(|| SongsterrError::PageParse("missing revisionId".into()))?;
    let image = current
        .get("image")
        .and_then(|x| x.as_str())
        .ok_or_else(|| SongsterrError::PageParse("missing image".into()))?
        .to_string();
    let title = current
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("Song")
        .to_string();
    let artist = current
        .get("artist")
        .and_then(|x| x.as_str())
        .unwrap_or("Unknown Artist")
        .to_string();

    let tracks_val = current.get("tracks").cloned().unwrap_or(serde_json::Value::Null);
    let tracks: Vec<SongsterrTrackMeta> =
        serde_json::from_value(tracks_val).unwrap_or_default();

    Ok(StateMeta { song_id, revision_id, image, title, artist, tracks })
}

/// Songsterr labels bass tracks with `instrument` strings like "bass" or
/// "Bass Guitar". A few songs use the track's `name` only, so we fall back
/// to a name match too. First match wins — most songs only have one.
fn pick_bass_track(tracks: &[SongsterrTrackMeta]) -> Option<&SongsterrTrackMeta> {
    tracks.iter().find(|t| {
        let s = t
            .instrument
            .as_deref()
            .or(t.name.as_deref())
            .unwrap_or("")
            .to_ascii_lowercase();
        s.contains("bass")
    })
}

async fn fetch_revision(
    client: &reqwest::Client,
    meta: &StateMeta,
    track: &SongsterrTrackMeta,
) -> Result<serde_json::Value, SongsterrError> {
    let try_one = |base: &str| -> String {
        format!(
            "{}/{}/{}/{}/{}.json",
            base, meta.song_id, meta.revision_id, meta.image, track.part_id
        )
    };
    for base in [CDN_PRIMARY, CDN_FALLBACK] {
        let url = try_one(base);
        let resp = client.get(&url).send().await?;
        if resp.status().is_success() {
            return Ok(resp.json::<serde_json::Value>().await?);
        }
    }
    Err(SongsterrError::RevisionFetch(format!(
        "no CDN returned a revision for part {}",
        track.part_id
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_state_meta_from_simple_page() {
        let html = r#"<html><head></head><body>
            <script id="state">
            {"meta":{"current":{"songId":42,"revisionId":7,"image":"abc","title":"Test","artist":"Band","tracks":[
              {"partId":1,"instrument":"vocals","name":"V"},
              {"partId":2,"instrument":"Bass Guitar","name":"Bass"}
            ]}}}
            </script>
        </body></html>"#;
        let meta = extract_state_meta(html).unwrap();
        assert_eq!(meta.song_id, 42);
        assert_eq!(meta.revision_id, 7);
        assert_eq!(meta.image, "abc");
        assert_eq!(meta.tracks.len(), 2);

        let bass = pick_bass_track(&meta.tracks).unwrap();
        assert_eq!(bass.part_id, 2);
    }

    #[test]
    fn pick_bass_track_uses_name_when_instrument_missing() {
        let tracks = vec![
            SongsterrTrackMeta {
                part_id: 1,
                track_id: None,
                instrument: None,
                name: Some("Lead Guitar".into()),
            },
            SongsterrTrackMeta {
                part_id: 2,
                track_id: None,
                instrument: None,
                name: Some("Bass".into()),
            },
        ];
        let picked = pick_bass_track(&tracks).unwrap();
        assert_eq!(picked.part_id, 2);
    }

    #[test]
    fn pick_bass_track_returns_none_when_absent() {
        let tracks = vec![SongsterrTrackMeta {
            part_id: 1,
            track_id: None,
            instrument: Some("Drums".into()),
            name: None,
        }];
        assert!(pick_bass_track(&tracks).is_none());
    }

    #[test]
    fn extract_state_meta_errors_on_missing_script() {
        let err = extract_state_meta("<html></html>").unwrap_err();
        assert!(matches!(err, SongsterrError::PageParse(_)));
    }
}
