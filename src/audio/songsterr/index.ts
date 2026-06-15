// Frontend entry point for Songsterr import.
//
// The Rust `fetch_songsterr_bass` command returns the page metadata + the
// bass track's revision JSON (see `src-tauri/src/songsterr.rs`). This
// module hands those off to the vendored alphaTab converter to produce
// MIDI bytes ready to feed into the existing `replace_bass_midi` Tauri
// command. Fingering extraction lives in a sibling file (slice 4); this
// file just wires up the data flow.

import { invoke } from "@tauri-apps/api/core";
import * as alphaTab from "@coderline/alphatab";
import { Midi } from "@tonejs/midi";
import type { Articulation } from "@/audio/midi";
import { DEFAULT_TUNING, enumeratePlacements } from "@/tab/optimizer";
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

/**
 * Explicit-fingering note produced by walking the alphaTab Score model
 * after Songsterr conversion. Bypasses the optimizer's string/fret
 * guesswork on load — we know the original tab's choice.
 */
export interface BassTabNote {
  startSec: number;
  durSec: number;
  pitch: number;
  velocity: number;
  /** 0-indexed wholabass string (0 = lowest pitch, E1 on standard bass). */
  string: number;
  fret: number;
  articulation?: Articulation;
}

export interface SongsterrImport {
  title: string;
  artist: string;
  /** Standard MIDI file bytes (single track — bass). */
  midi: Uint8Array;
  /** Same notes, with the original tab's string + fret preserved. */
  tab: BassTabNote[];
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
  // We need the Score model for fingering AND the MIDI bytes for synth +
  // beat tracking. Run both through the converter; toMidi already runs
  // buildScore internally, but we also build it once here so we can walk
  // it for string/fret. Cheap — both calls share zero state.
  const { data: midi, warnings } = converter.toMidi({ meta, revisions });
  const { score } = buildScoreFor(meta, revisions);
  const tab = scoreToBassTab(score, midi);

  return { title: raw.title, artist: raw.artist, midi, tab, warnings };
}

function buildScoreFor(
  meta: SongsterrStateMetaCurrent,
  revisions: {
    trackMeta: SongsterrStateMetaCurrentTrack;
    revision: SongsterrRevisionTrackPayload;
  }[],
): { score: alphaTab.model.Score } {
  // Reach back into the same private builder via a fresh converter — the
  // public toGp7/toMidi callers don't expose Score, but constructing one
  // ourselves keeps the surgical change off the upstream converter.
  const conv = new SongsterrToAlphaTabConverter();
  // `toMidi` returns just bytes; we re-derive the Score here. Future
  // optimization: expose a `buildScore()` on the converter so we don't
  // build it twice. For a one-shot import the cost is negligible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const score = (
    conv as unknown as { buildScore: (i: unknown) => { score: alphaTab.model.Score } }
  ).buildScore({ meta, revisions }).score;
  return { score };
}

/**
 * Walk the alphaTab Score in lock-step with the MIDI's NoteOn order to
 * produce one BassTabNote per NoteOn — carrying authoritative timing
 * (from MIDI) AND the original tab's string/fret (from Score).
 *
 * The two iterations match because alphaTab's `MidiFileGenerator` walks
 * bars → voices → beats → notes in the same order we do. Tied/dead notes
 * are skipped on both sides.
 */
function scoreToBassTab(score: alphaTab.model.Score, midiBytes: Uint8Array): BassTabNote[] {
  const midi = new Midi(midiBytes);
  // The converter puts the (only) bass track on the first non-empty MIDI
  // track. Flatten across tracks to be defensive in case alphaTab adds a
  // tempo-only track 0.
  const midiNotes = midi.tracks
    .flatMap((t) =>
      t.notes.map((n) => ({
        startSec: n.time,
        durSec: n.duration,
        pitch: n.midi,
        velocity: n.velocity,
      })),
    )
    .toSorted((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);

  const track = score.tracks[0];
  const staff = track?.staves[0];
  if (!staff) return [];
  const numStrings = staff.tuning?.length ?? 4;

  interface ScoreNote {
    string: number;
    fret: number;
    pitch: number;
    articulation?: Articulation;
  }
  const scoreNotes: ScoreNote[] = [];
  for (const bar of staff.bars) {
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest || beat.isEmpty) continue;
        // Sort within-beat notes by ascending pitch BEFORE pushing so
        // the global order matches midiNotes' `(startSec, pitch)` sort
        // below. Without this the alphaTab `beat.notes` iteration
        // returns chord notes in some non-pitch order (often string-
        // descending), and the index-paired join further down mates
        // each pitch with the WRONG (string, fret) — manifesting as a
        // 3-note chord whose outer notes get their fingerings swapped
        // while the middle one happens to look right. We don't have
        // absolute start times on `ScoreNote`, but a strict bar →
        // voice → beat traversal is monotonically non-decreasing in
        // time, so within-beat sort by pitch is sufficient as long as
        // the import is single-voice (the common case for bass).
        const playedNotes = beat.notes
          .filter((n) => !n.isTieDestination && !n.isDead)
          .toSorted((a, b) => a.realValue - b.realValue);
        for (const note of playedNotes) {
          scoreNotes.push({
            // alphaTab string is 1-indexed with 1 = lowest pitch. Wholabass
            // uses 0-indexed with 0 = lowest pitch.
            string: Math.max(0, Math.min(numStrings - 1, note.string - 1)),
            fret: note.fret,
            pitch: note.realValue,
            articulation: buildArticulation(beat, note),
          });
        }
      }
    }
  }

  // Songsterr songs are often authored on non-standard tunings (5-string
  // basses with low B, drop-D, half-step-down, etc.). alphaTab's
  // `realValue` accounts for the source tuning, so the imported pitch
  // is correct — but the matching `string + fret` only adds up under
  // that tuning. Renderer + popover assume standard `DEFAULT_TUNING`,
  // so a note like `string=0, fret=7, realValue=28` reads as a broken
  // invariant ("E1 should be open E, not E-string fret 7"). For every
  // such note, re-pick the placement against the standard fretboard so
  // what the user sees matches what they hear.
  let normalised = 0;
  let unreachable = 0;
  for (const s of scoreNotes) {
    if (s.pitch === DEFAULT_TUNING[s.string] + s.fret) continue;
    const placements = enumeratePlacements(s.pitch, DEFAULT_TUNING);
    if (placements.length > 0) {
      // Pick the placement closest to the ORIGINAL fret — the source
      // tab's fret number is a hint about the hand position the
      // arranger intended, so keep the new placement near it. Ties
      // broken by preferring the lower fret (closer to first
      // position, easier for sight-reading). The old logic preferred
      // "lowest string" which sent C3 to E-string fret 20 instead of
      // the obvious D-string fret 10 — visually unplayable.
      const best = placements.toSorted((a, b) => {
        const da = Math.abs(a.fret - s.fret);
        const db = Math.abs(b.fret - s.fret);
        return da - db || a.fret - b.fret;
      })[0];
      s.string = best.string;
      s.fret = best.fret;
      normalised++;
    } else {
      // Pitch is below `DEFAULT_TUNING[0]` (E1) — off the standard
      // fretboard entirely. Park it on the lowest string at fret 0 so
      // it still renders; the synth still plays the original pitch.
      s.string = 0;
      s.fret = 0;
      unreachable++;
    }
  }
  if (normalised || unreachable) {
    // eslint-disable-next-line no-console
    console.warn(
      `songsterr import: normalised ${normalised} fingering(s) onto standard tuning` +
        (unreachable ? ` (${unreachable} note(s) below E1, parked at open E)` : ""),
    );
  }

  const out: BassTabNote[] = [];
  const n = Math.min(midiNotes.length, scoreNotes.length);
  for (let i = 0; i < n; i++) {
    const m = midiNotes[i];
    const s = scoreNotes[i];
    out.push({
      startSec: m.startSec,
      durSec: m.durSec,
      pitch: m.pitch,
      velocity: m.velocity,
      string: s.string,
      fret: s.fret,
      ...(s.articulation ? { articulation: s.articulation } : {}),
    });
  }
  return out;
}

function buildArticulation(
  beat: alphaTab.model.Beat,
  note: alphaTab.model.Note,
): Articulation | undefined {
  const art: Articulation = {};
  if (note.isStaccato) art.staccato = true;
  if (note.isPalmMute || beat.isPalmMute) art.palmMute = true;
  if (note.isGhost) art.ghost = true;
  if (note.harmonicType !== alphaTab.model.HarmonicType.None) art.harmonic = true;
  if (note.isHammerPullOrigin) art.legato = true;
  if (note.slideOutType !== alphaTab.model.SlideOutType.None) art.slide = true;
  if (
    note.vibrato !== alphaTab.model.VibratoType.None ||
    beat.vibrato !== alphaTab.model.VibratoType.None
  ) {
    art.vibrato = true;
  }
  if (note.hasBend) {
    // alphaTab measures bends in quarter-tones (1 = 25 cents). Round to
    // half / whole steps which is what our editor exposes.
    const semitones = Math.round((note.maxBendPoint?.value ?? 0) / 2);
    if (semitones > 0) art.bend = { semitones };
  }
  return Object.keys(art).length > 0 ? art : undefined;
}
