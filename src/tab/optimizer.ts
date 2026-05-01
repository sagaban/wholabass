/**
 * MIDI → bass fingering. Dynamic programming over per-note placements
 * `(string, fret)`. State at each note is "which placement was chosen";
 * transitions pay for hand movement (|fret diff| + small string-switch
 * penalty) plus a gentle pull toward a preferred neck region. Per-note
 * cost is the region distance only, so a single note in isolation
 * lands near the preferred fret.
 *
 * Pure module — no React, no Web Audio. Drives the SVG tab renderer
 * (T15) and re-runs in <100 ms for a 4-min song so the UI can hand it
 * to a parameter slider.
 */

import type { BassNote } from "@/audio/midi";

export interface TabNote extends BassNote {
  /** 0-indexed string from low (E) to high (G). */
  string: number;
  fret: number;
}

export interface OptimizerOptions {
  /** Open-string MIDI pitches, low-to-high. Default `[E1, A1, D2, G2]`. */
  tuning?: readonly number[];
  /** Semitone shift applied to every input pitch before placing. */
  octaveShift?: number;
  /** Reject placements above this fret. Default 12. */
  maxFret?: number;
  /** Region around which placements are pulled. Default 5. */
  preferredFret?: number;
  /** Per-string-step cost on transition. Default 0.5. */
  stringSwitchPenalty?: number;
  /** Weight on `|fret - preferredFret|` per placement. Default 0.3. */
  regionWeight?: number;
}

/** E1 A1 D2 G2 — standard 4-string bass. */
export const DEFAULT_TUNING: readonly number[] = [28, 33, 38, 43] as const;

interface Placement {
  string: number;
  fret: number;
}

function placementsFor(pitch: number, tuning: readonly number[], maxFret: number): Placement[] {
  const out: Placement[] = [];
  for (let s = 0; s < tuning.length; s++) {
    const fret = pitch - tuning[s];
    if (fret >= 0 && fret <= maxFret) out.push({ string: s, fret });
  }
  return out;
}

function fallbackPlacement(pitch: number, tuning: readonly number[], maxFret: number): Placement {
  // Note is unreachable in the requested tuning + maxFret range. Pick the
  // closest in-range placement so the tab still renders something the user
  // can spot and fix manually.
  let best: Placement = { string: 0, fret: 0 };
  let bestDist = Infinity;
  for (let s = 0; s < tuning.length; s++) {
    const ideal = pitch - tuning[s];
    const fret = Math.max(0, Math.min(maxFret, ideal));
    const dist = Math.abs(ideal - fret);
    if (dist < bestDist) {
      bestDist = dist;
      best = { string: s, fret };
    }
  }
  return best;
}

export function fingerNotes(notes: readonly BassNote[], options: OptimizerOptions = {}): TabNote[] {
  if (notes.length === 0) return [];

  const tuning = options.tuning ?? DEFAULT_TUNING;
  const octaveShift = options.octaveShift ?? 0;
  const maxFret = options.maxFret ?? 12;
  const preferredFret = options.preferredFret ?? 5;
  const stringSwitchPenalty = options.stringSwitchPenalty ?? 0.5;
  const regionWeight = options.regionWeight ?? 0.3;

  const candidates: Placement[][] = notes.map((n) => {
    const placements = placementsFor(n.pitch + octaveShift, tuning, maxFret);
    return placements.length > 0
      ? placements
      : [fallbackPlacement(n.pitch + octaveShift, tuning, maxFret)];
  });

  // The region pull only applies at the first note, to anchor where on the
  // neck we start. After that, transitions are purely about hand movement
  // — otherwise a long ascending scale's accumulated region preference
  // can overwhelm the string-switch penalty and pull the path onto a
  // different string mid-run.
  const anchorCost = (p: Placement): number => regionWeight * Math.abs(p.fret - preferredFret);
  const transCost = (prev: Placement, curr: Placement): number =>
    Math.abs(curr.fret - prev.fret) + stringSwitchPenalty * Math.abs(curr.string - prev.string);

  const cost: number[][] = [];
  const back: number[][] = [];

  for (let i = 0; i < notes.length; i++) {
    const ps = candidates[i];
    const row: number[] = Array.from({ length: ps.length });
    const ptr: number[] = Array.from({ length: ps.length });
    for (let k = 0; k < ps.length; k++) {
      if (i === 0) {
        row[k] = anchorCost(ps[k]);
        ptr[k] = -1;
      } else {
        const prev = candidates[i - 1];
        let bestCost = Infinity;
        let bestJ = 0;
        for (let j = 0; j < prev.length; j++) {
          const total = cost[i - 1][j] + transCost(prev[j], ps[k]);
          if (total < bestCost) {
            bestCost = total;
            bestJ = j;
          }
        }
        row[k] = bestCost;
        ptr[k] = bestJ;
      }
    }
    cost.push(row);
    back.push(ptr);
  }

  // Pick the best last-note placement, then trace back.
  const last = candidates.length - 1;
  let bestK = 0;
  let bestCost = Infinity;
  for (let k = 0; k < candidates[last].length; k++) {
    if (cost[last][k] < bestCost) {
      bestCost = cost[last][k];
      bestK = k;
    }
  }

  const picks: number[] = Array.from({ length: notes.length });
  picks[last] = bestK;
  for (let i = last; i > 0; i--) {
    picks[i - 1] = back[i][picks[i]];
  }

  return notes.map((n, i) => ({
    ...n,
    string: candidates[i][picks[i]].string,
    fret: candidates[i][picks[i]].fret,
  }));
}
