/**
 * Quick-and-dirty key estimator for a bass-note list.
 *
 * Approach: Krumhansl-Schmuckler tonal-profile correlation. Build a
 * duration-weighted pitch-class histogram from the notes, then correlate
 * against the 12 rotations of the major and minor templates. The best-
 * correlating (tonic, mode) wins. Pure module — no audio analysis.
 *
 * MIDI-only is enough to identify the tonic ~90% of the time on rock /
 * pop bass lines, since bass tends to ground the root. Mode can flip
 * (relative major / minor share the same pitch classes), but the tonic
 * pitch class is usually right.
 */

import type { BassNote } from "@/audio/midi";

export interface KeyEstimate {
  /** "C", "C#", "D", … */
  tonic: string;
  /** 0..11 (C..B). */
  pitchClass: number;
  mode: "major" | "minor";
  /** Pearson correlation of the histogram against the chosen profile (-1..1). */
  confidence: number;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

// Krumhansl-Kessler probe-tone profiles (Cognitive Foundations of
// Musical Pitch, 1990). Indexed C..B for the C-major / C-minor case;
// other tonics are obtained by rotation.
const PROFILE_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
] as const;
const PROFILE_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
] as const;

/** Duration-weighted pitch-class histogram. Sustained notes count for more. */
export function pitchClassHistogram(notes: readonly BassNote[]): number[] {
  const h = Array.from({ length: 12 }, () => 0);
  for (const n of notes) {
    const pc = ((n.pitch % 12) + 12) % 12;
    h[pc] += Math.max(n.durSec, 0.05);
  }
  return h;
}

/** Pearson correlation. Returns 0 when either side is constant. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}

function rotate(profile: readonly number[], by: number): number[] {
  const n = profile.length;
  const out = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n; i++) {
    out[i] = profile[(((i - by) % n) + n) % n];
  }
  return out;
}

export function estimateKey(notes: readonly BassNote[]): KeyEstimate | null {
  if (notes.length === 0) return null;
  const hist = pitchClassHistogram(notes);
  if (hist.every((v) => v === 0)) return null;

  let bestTonic = 0;
  let bestMode: "major" | "minor" = "major";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let tonic = 0; tonic < 12; tonic++) {
    const cMaj = pearson(hist, rotate(PROFILE_MAJOR, tonic));
    if (cMaj > bestScore) {
      bestScore = cMaj;
      bestTonic = tonic;
      bestMode = "major";
    }
    const cMin = pearson(hist, rotate(PROFILE_MINOR, tonic));
    if (cMin > bestScore) {
      bestScore = cMin;
      bestTonic = tonic;
      bestMode = "minor";
    }
  }

  return {
    tonic: NOTE_NAMES[bestTonic],
    pitchClass: bestTonic,
    mode: bestMode,
    confidence: bestScore,
  };
}
