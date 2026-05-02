/**
 * Quantize a continuous-time `BassNote` duration into a standard
 * music-notation rhythm (quarter, eighth, sixteenth, dotted variants),
 * relative to the local beat duration from the song's beat track.
 *
 * Pure module — no DOM. The Tab renderer reads `RhythmKind` and draws
 * flags / stems / dots from it.
 */

import type { BassNote } from "@/audio/midi";

export type RhythmKind =
  | "whole"
  | "dottedHalf"
  | "half"
  | "dottedQuarter"
  | "quarter"
  | "dottedEighth"
  | "eighth"
  | "sixteenth";

interface RhythmCandidate {
  kind: RhythmKind;
  /** Duration relative to a quarter-note beat. */
  beats: number;
}

const CANDIDATES: readonly RhythmCandidate[] = [
  { kind: "sixteenth", beats: 0.25 },
  { kind: "eighth", beats: 0.5 },
  { kind: "dottedEighth", beats: 0.75 },
  { kind: "quarter", beats: 1.0 },
  { kind: "dottedQuarter", beats: 1.5 },
  { kind: "half", beats: 2.0 },
  { kind: "dottedHalf", beats: 3.0 },
  { kind: "whole", beats: 4.0 },
] as const;

export interface RhythmGlyph {
  /** 0 = quarter or longer, 1 = eighth, 2 = sixteenth. */
  flags: number;
  /** True for dotted variants (3/2 of the base length). */
  dotted: boolean;
  /** True when the base duration is < a quarter (drives stem rendering). */
  shortNote: boolean;
}

const GLYPHS: Record<RhythmKind, RhythmGlyph> = {
  whole: { flags: 0, dotted: false, shortNote: false },
  dottedHalf: { flags: 0, dotted: true, shortNote: false },
  half: { flags: 0, dotted: false, shortNote: false },
  dottedQuarter: { flags: 0, dotted: true, shortNote: false },
  quarter: { flags: 0, dotted: false, shortNote: false },
  dottedEighth: { flags: 1, dotted: true, shortNote: true },
  eighth: { flags: 1, dotted: false, shortNote: true },
  sixteenth: { flags: 2, dotted: false, shortNote: true },
};

export function rhythmGlyph(kind: RhythmKind): RhythmGlyph {
  return GLYPHS[kind];
}

/**
 * Find `i` such that `beats[i] <= time < beats[i+1]`. Returns the last
 * gap when `time` exceeds the array, and the first when it precedes it.
 * Assumes `beats` is sorted ascending; out-of-range falls back gracefully
 * so the caller never needs to handle `null`.
 */
export function beatIndexAt(time: number, beats: readonly number[]): number {
  if (beats.length < 2) return 0;
  if (time <= beats[0]) return 0;
  if (time >= beats[beats.length - 1]) return beats.length - 2;
  let lo = 0;
  let hi = beats.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Local beat (quarter-note) duration in seconds at `time`. */
export function localBeatDuration(time: number, beats: readonly number[]): number {
  const i = beatIndexAt(time, beats);
  if (beats.length < 2) return 0.5;
  const dur = beats[i + 1] - beats[i];
  return dur > 0 ? dur : 0.5;
}

/**
 * Snap a duration (in seconds) to its nearest standard rhythmic value
 * using the local quarter-note duration. Picks the candidate that
 * minimises absolute log-ratio so it doesn't bias toward longer values
 * like a plain absolute-difference would.
 */
export function classifyDuration(durSec: number, beatDurSec: number): RhythmKind {
  const inBeats = durSec / Math.max(beatDurSec, 1e-6);
  let best = CANDIDATES[0];
  let bestErr = Infinity;
  for (const c of CANDIDATES) {
    const err = Math.abs(Math.log(inBeats / c.beats));
    if (err < bestErr) {
      best = c;
      bestErr = err;
    }
  }
  return best.kind;
}

export function classifyNote(note: BassNote, beats: readonly number[]): RhythmKind {
  return classifyDuration(note.durSec, localBeatDuration(note.startSec, beats));
}

export interface BeamGroup {
  /** Indices into the input note array. Always sorted. */
  indices: number[];
  /**
   * How many parallel beam lines to draw. 1 for an eighth-note group,
   * 2 for a sixteenth-note group. Mixed groups use the max so a single
   * sixteenth among eighths still gets its inner beam (not exact music
   * notation, but readable for tablature).
   */
  beamLevels: number;
}

const SHORT_LEVELS: Partial<Record<RhythmKind, number>> = {
  eighth: 1,
  dottedEighth: 1,
  sixteenth: 2,
};

/**
 * Group consecutive short notes (eighths + sixteenths) that fall into
 * the same beat into a single beam. Notes that don't qualify (quarters
 * or longer, or alone in their beat) get a singleton group; the
 * renderer can then choose to draw an individual flag for those.
 */
export function beamGroups(notes: readonly BassNote[], beats: readonly number[]): BeamGroup[] {
  if (notes.length === 0) return [];
  const out: BeamGroup[] = [];
  let curIndices: number[] = [];
  let curBeatIdx = -1;
  let curLevels = 0;

  const flush = () => {
    if (curIndices.length === 0) return;
    out.push({ indices: curIndices, beamLevels: curLevels });
    curIndices = [];
    curLevels = 0;
  };

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const kind = classifyNote(n, beats);
    const level = SHORT_LEVELS[kind] ?? 0;
    if (level === 0) {
      flush();
      out.push({ indices: [i], beamLevels: 0 });
      curBeatIdx = -1;
      continue;
    }
    const beatIdx = beatIndexAt(n.startSec, beats);
    if (beatIdx !== curBeatIdx) {
      flush();
      curBeatIdx = beatIdx;
    }
    curIndices.push(i);
    if (level > curLevels) curLevels = level;
  }
  flush();
  return out;
}
