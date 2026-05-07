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

/** MIDI pitch → name + octave (e.g., 60 → "C4", 28 → "E1"). */
export function pitchName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[((midi % 12) + 12) % 12]}${octave}`;
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

/**
 * Quick metadata read from a MIDI buffer: initial tempo + the
 * earliest note start across all tracks. Used by the "auto-match"
 * affordance to align an upload to the song's audio. Returns null
 * when the file has no notes (auto-match is meaningless then).
 */
export function readMidiAlignmentMetadata(
  bytes: ArrayBuffer,
): { tempoBpm: number; firstNoteSec: number } | null {
  const m = new Midi(bytes);
  let earliest = Number.POSITIVE_INFINITY;
  for (const track of m.tracks) {
    for (const n of track.notes) {
      if (n.time < earliest) earliest = n.time;
    }
  }
  if (!Number.isFinite(earliest)) return null;
  // header.tempos is sorted; first entry is the initial bpm.
  const tempoBpm = m.header.tempos[0]?.bpm ?? 120;
  return { tempoBpm, firstNoteSec: earliest };
}

/** Every onset (note start) across all tracks of a MIDI buffer, sorted. */
export function readMidiOnsets(bytes: ArrayBuffer): number[] {
  const m = new Midi(bytes);
  const out: number[] = [];
  for (const track of m.tracks) {
    for (const n of track.notes) out.push(n.time);
  }
  out.sort((a, b) => a - b);
  return out;
}

export interface AlignmentResult {
  speed: number;
  offset: number;
  /** Number of MIDI onsets that landed within `tolerance` of an audio onset. */
  matches: number;
  /** Total MIDI onsets considered (capped). */
  totalMidiOnsets: number;
}

/**
 * Score a single (speed, offset) candidate by counting MIDI onsets
 * whose mapped position lands within `tolerance` of an audio onset.
 * Both lists are assumed sorted.
 */
function countOnsetMatches(
  audio: readonly number[],
  midi: readonly number[],
  speed: number,
  offset: number,
  tolerance: number,
): number {
  if (audio.length === 0 || midi.length === 0) return 0;
  let matches = 0;
  let j = 0;
  for (const t of midi) {
    const target = t / speed + offset;
    while (j + 1 < audio.length && audio[j + 1] < target) j++;
    const a = audio[j];
    const b = j + 1 < audio.length ? audio[j + 1] : a;
    const dist = Math.min(Math.abs(target - a), Math.abs(target - b));
    if (dist <= tolerance) matches++;
  }
  return matches;
}

/**
 * Find the (speed, offset) that best aligns `midiOnsets` onto
 * `audioOnsets`. Sweeps speed in a band around `baseSpeed` (so a
 * meaningfully wrong base — e.g. one side reporting half-time —
 * needs a folded base, not extra range here) and offset over a
 * coarse grid, then refines around the best coarse pick.
 */
export function findBestAlignment(
  audioOnsets: readonly number[],
  midiOnsets: readonly number[],
  baseSpeed: number,
  options: {
    speedRel?: number; // ± fraction around baseSpeed (default 0.08 = ±8%)
    speedSteps?: number;
    offsetMin?: number;
    offsetMax?: number;
    coarseStep?: number;
    fineStep?: number;
    tolerance?: number;
    maxMidiOnsets?: number;
    /**
     * Restrict matching to onsets in the first N seconds of each
     * stream. Aligns entry + early pulse without being skewed by
     * mid-song tempo drift, missing notes, or ornamentation.
     */
    prefixSec?: number;
  } = {},
): AlignmentResult | null {
  const speedRel = options.speedRel ?? 0.08;
  const speedSteps = options.speedSteps ?? 17;
  const offsetMin = options.offsetMin ?? -3;
  const offsetMax = options.offsetMax ?? 15;
  const coarseStep = options.coarseStep ?? 0.05;
  const fineStep = options.fineStep ?? 0.005;
  const tolerance = options.tolerance ?? 0.06;
  const maxMidiOnsets = options.maxMidiOnsets ?? 1500;
  const prefixSec = options.prefixSec;

  if (audioOnsets.length === 0 || midiOnsets.length === 0) return null;

  // Optionally trim both streams to their first N seconds (relative to
  // each stream's own t=0). Caller picks the window — usually 20-30 s
  // for the song-entry alignment.
  const audio =
    prefixSec === undefined
      ? audioOnsets
      : audioOnsets.filter((t) => t <= audioOnsets[0] + prefixSec);
  const midiTrim =
    prefixSec === undefined ? midiOnsets : midiOnsets.filter((t) => t <= midiOnsets[0] + prefixSec);
  if (audio.length === 0 || midiTrim.length === 0) return null;

  // Cap MIDI onsets to keep the inner loop bounded; downsample by
  // keeping every N-th onset rather than the first N so we still
  // sample across the full prefix window.
  const stride = Math.max(1, Math.ceil(midiTrim.length / maxMidiOnsets));
  const midiSampled = stride === 1 ? midiTrim.slice() : midiTrim.filter((_, i) => i % stride === 0);

  let best: AlignmentResult | null = null;

  for (let s = 0; s < speedSteps; s++) {
    const speed =
      baseSpeed * (1 + speedRel * ((s - (speedSteps - 1) / 2) / Math.max(1, (speedSteps - 1) / 2)));
    if (speed <= 0) continue;
    for (let o = offsetMin; o <= offsetMax + 1e-9; o += coarseStep) {
      const matches = countOnsetMatches(audio, midiSampled, speed, o, tolerance);
      if (!best || matches > best.matches) {
        best = { speed, offset: o, matches, totalMidiOnsets: midiSampled.length };
      }
    }
  }

  if (!best) return null;

  // Refine the offset with a finer sweep around the coarse best.
  const refineMin = best.offset - coarseStep;
  const refineMax = best.offset + coarseStep;
  for (let o = refineMin; o <= refineMax + 1e-9; o += fineStep) {
    const matches = countOnsetMatches(audio, midiSampled, best.speed, o, tolerance);
    if (matches > best.matches) best = { ...best, offset: o, matches };
  }

  return best;
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
