/**
 * Pure layout helpers for the SVG tab renderer.
 *
 * Coordinate system: x grows with time (seconds × pixelsPerSecond), y
 * grows downward. The four string lines are stacked top-to-bottom in
 * the standard tab order: G (highest pitch) on top, then D, A, E.
 *
 * No DOM here — exported for the React Tab component and a vitest suite.
 */

export interface TabLayout {
  /** Horizontal scale factor. 80 px/sec is comfortable at 4-min songs. */
  pixelsPerSecond: number;
  /** Vertical gap between adjacent string lines. */
  stringLineSpacing: number;
  /** Padding above the staff. Bar numbers + tempo header live here. */
  topPadding: number;
  /** Padding below the staff. Rhythm beams will live here in T18. */
  bottomPadding: number;
  /** Bar grouping. 4 = 4/4 time. */
  beatsPerBar: number;
  /** Visible string count. 4 for standard bass. */
  stringCount: number;
}

export const DEFAULT_LAYOUT: TabLayout = {
  pixelsPerSecond: 80,
  stringLineSpacing: 18,
  topPadding: 28,
  bottomPadding: 24,
  beatsPerBar: 4,
  stringCount: 4,
};

export function timeToX(timeSec: number, layout: TabLayout): number {
  return timeSec * layout.pixelsPerSecond;
}

/** Inverse of timeToX, used to translate scroll offset back to seconds. */
export function xToTime(x: number, layout: TabLayout): number {
  return x / layout.pixelsPerSecond;
}

/**
 * Y of the line for a given string index (0 = E, ..., stringCount-1 = G).
 * G is on top in standard tab order, so we flip the index.
 */
export function stringIndexToY(stringIdx: number, layout: TabLayout): number {
  const fromTop = layout.stringCount - 1 - stringIdx;
  return layout.topPadding + fromTop * layout.stringLineSpacing;
}

export function staffHeight(layout: TabLayout): number {
  return (layout.stringCount - 1) * layout.stringLineSpacing;
}

export function totalHeight(layout: TabLayout): number {
  return layout.topPadding + staffHeight(layout) + layout.bottomPadding;
}

export function totalWidth(durationSec: number, layout: TabLayout): number {
  return Math.max(0, timeToX(durationSec, layout));
}

/**
 * Bar-line times derived from a beat track. Returns the times (in
 * seconds) where each bar starts — i.e., every `beatsPerBar`th beat.
 */
export function barLineTimes(beats: readonly number[], beatsPerBar: number): number[] {
  if (beatsPerBar <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < beats.length; i += beatsPerBar) {
    out.push(beats[i]);
  }
  return out;
}
