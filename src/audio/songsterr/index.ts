// Frontend entry point for Songsterr import.
//
// The Rust `fetch_songsterr_bass` command returns the page metadata + the
// bass track's revision JSON (see `src-tauri/src/songsterr.rs`). This
// module hands those off to the vendored alphaTab converter to produce
// MIDI bytes ready to feed into the existing `replace_bass_midi` Tauri
// command. Fingering extraction lives in a sibling file (slice 4); this
// file just wires up the data flow.

import { invoke } from "@tauri-apps/api/core";
import { SongsterrToAlphaTabConverter } from "./converter";
import type {
  ConversionWarning,
  SongsterrRevisionTrackPayload,
  SongsterrStateMetaCurrent,
  SongsterrStateMetaCurrentTrack,
} from "./types";

/**
 * Shape returned by the Rust `fetch_songsterr_bass` command. Mirrors
 * `SongsterrBassResult` in `src-tauri/src/songsterr.rs`.
 */
export interface SongsterrBassResult {
  title: string;
  artist: string;
  /** Names follow Rust's snake_case; serde converts to/from JSON as-is. */
  song_id: number;
  revision_id: number;
  image: string;
  track: SongsterrStateMetaCurrentTrack;
  revision: SongsterrRevisionTrackPayload;
}

export interface SongsterrImport {
  title: string;
  artist: string;
  /** Standard MIDI file bytes (single track — bass). */
  midi: Uint8Array;
  warnings: ConversionWarning[];
}

/**
 * Fetch + convert in one go: scrape Songsterr, pick bass, run alphaTab,
 * produce a SMF buffer. Throws on network / parse / conversion failure.
 */
export async function importSongsterrBass(url: string): Promise<SongsterrImport> {
  const raw = await invoke<SongsterrBassResult>("fetch_songsterr_bass", { url });

  // The converter takes `{meta, revisions}` where meta lists *all* tracks
  // (for chord names, master tempo, etc.). We only ever have one — the
  // bass track — so meta.tracks contains just it.
  const meta: SongsterrStateMetaCurrent = {
    songId: raw.song_id,
    revisionId: raw.revision_id,
    image: raw.image,
    title: raw.title,
    artist: raw.artist,
    tracks: [raw.track],
  };
  const revisions = [{ trackMeta: raw.track, revision: raw.revision }];

  const converter = new SongsterrToAlphaTabConverter();
  const { data, warnings } = converter.toMidi({ meta, revisions });

  return { title: raw.title, artist: raw.artist, midi: data, warnings };
}
