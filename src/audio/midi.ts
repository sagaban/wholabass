import { invoke } from "@tauri-apps/api/core";
import { Midi } from "@tonejs/midi";

export interface BassNote {
  /** MIDI pitch number (0-127). Bass typically lives in E1=28 .. G4=67. */
  pitch: number;
  /** Note start in seconds. */
  startSec: number;
  /** Note duration in seconds. */
  durSec: number;
  /** Normalised velocity 0..1. */
  velocity: number;
}

/** Fetch + parse `library/<id>/bass.mid` into a flat note list (sorted by start). */
export async function loadBassNotes(songId: string): Promise<BassNote[]> {
  const bytes = await invoke<ArrayBuffer>("read_midi", { songId });
  const midi = new Midi(bytes);
  const notes: BassNote[] = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        pitch: n.midi,
        startSec: n.time,
        durSec: n.duration,
        velocity: n.velocity,
      });
    }
  }
  notes.sort((a, b) => a.startSec - b.startSec);
  return notes;
}

export interface MidiTrackInfo {
  index: number;
  name: string;
  noteCount: number;
  /** [lowest, highest] MIDI pitch among the track's notes; null when empty. */
  pitchRange: [number, number] | null;
  /** General MIDI program number (0..127). */
  program: number;
  /** True if `program` falls in the bass-instrument range (32..39). */
  programIsBass: boolean;
}

/** Bass MIDI range — E1 (28) to G4 (67) covers a 4-string 24-fret. */
const BASS_LO = 28;
const BASS_HI = 67;

/** Inspect a Standard MIDI file's tracks for the upload picker. */
export function describeMidiTracks(bytes: ArrayBuffer): MidiTrackInfo[] {
  const midi = new Midi(bytes);
  return midi.tracks.map((t, index) => {
    const notes = t.notes;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const n of notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    const program = t.instrument?.number ?? 0;
    return {
      index,
      name: t.name?.trim() || `Track ${index + 1}`,
      noteCount: notes.length,
      pitchRange: notes.length > 0 ? [lo, hi] : null,
      program,
      // GM bass programs: 32 (Acoustic Bass) … 39 (Synth Bass 2).
      programIsBass: program >= 32 && program <= 39,
    };
  });
}

/**
 * Heuristic: which track is most likely the bass line? Bias toward
 * tracks with a bass-flagged GM program; fall back to "median pitch
 * lands in the bass range and there's a meaningful number of notes".
 */
export function suggestBassTrack(tracks: readonly MidiTrackInfo[]): number {
  if (tracks.length === 0) return 0;
  const populated = tracks.filter((t) => t.noteCount > 0);
  if (populated.length === 0) return 0;
  const explicit = populated.find((t) => t.programIsBass);
  if (explicit) return explicit.index;
  // Pick the track with the most notes whose pitch range overlaps the bass band.
  let best = populated[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const t of populated) {
    if (!t.pitchRange) continue;
    const [lo, hi] = t.pitchRange;
    const overlapsBass = lo <= BASS_HI && hi >= BASS_LO;
    if (!overlapsBass) continue;
    const midpoint = (lo + hi) / 2;
    // Closer to the centre of the bass band scores higher; tied scores
    // break by note count (more notes = more interesting line).
    const distScore = -Math.abs(midpoint - (BASS_LO + BASS_HI) / 2);
    const score = distScore * 1000 + t.noteCount;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best.index;
}

/** Re-encode the original MIDI keeping only the chosen track. */
export function extractTrackToMidi(bytes: ArrayBuffer, trackIndex: number): Uint8Array {
  const src = new Midi(bytes);
  if (trackIndex < 0 || trackIndex >= src.tracks.length) {
    throw new Error(`track index ${trackIndex} out of range`);
  }
  const out = new Midi();
  // Carry over tempo + meter so beats / rhythm classification still
  // matches when the new file is re-loaded.
  out.header = src.header;
  const source = src.tracks[trackIndex];
  const dest = out.addTrack();
  dest.name = source.name;
  if (source.instrument) {
    dest.instrument.number = source.instrument.number;
  }
  for (const n of source.notes) {
    dest.addNote({
      midi: n.midi,
      time: n.time,
      duration: n.duration,
      velocity: n.velocity,
    });
  }
  return out.toArray();
}
