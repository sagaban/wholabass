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
  // Header band fits, top to bottom: section labels (2..18), bar
  // chord-root labels (~24..36), bar numbers (~38..46).
  topPadding: 46,
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

export interface TabSystem {
  /** Inclusive song-time at the system's left edge. */
  startSec: number;
  /** Exclusive song-time at the system's right edge. */
  endSec: number;
  /** Bar number of the first bar shown (1-based, matches the bar label). */
  startBarNumber: number;
  /** Width in pixels at `layout.pixelsPerSecond`. */
  widthPx: number;
}

export interface PlannedSystem {
  startSec: number;
  endSec: number;
  startBarNumber: number;
  /** Total row width in pixels. */
  widthPx: number;
  /** Fixed left margin where bar 1 of the row starts. */
  leadInPx: number;
  /**
   * Anchor times within the row + their assigned x. Includes the row's
   * leading edge (system start) and one entry per bar boundary inside
   * the row. Last entry's x is `widthPx`.
   * Use this list to map a time `t` to an x-coordinate via piecewise
   * linear interpolation — that's what keeps bar lines at uniform
   * x-positions across rows even when tempo varies.
   */
  anchors: { sec: number; x: number }[];
}

/**
 * Lay out the song into rows where every bar occupies a fixed pixel
 * width (so bar lines line up vertically across rows). Computes
 * `barsPerRow` from `containerWidthPx / minBarWidthPx`, then chunks
 * `bars` into rows of that size. The first row's lead-in holds any
 * intro before bar 1; subsequent rows use that same lead-in as empty
 * left margin so their bar lines stay aligned with row 1.
 */
export function planSystems(
  durationSec: number,
  bars: readonly number[],
  _layout: TabLayout,
  containerWidthPx: number,
  options: { minBarWidthPx?: number; leadInPx?: number } = {},
): PlannedSystem[] {
  const dur = Math.max(0, durationSec);
  if (dur <= 0) return [];

  const minBarWidthPx = options.minBarWidthPx ?? 200;
  const FIXED_LEADIN_DEFAULT = 24;

  if (bars.length < 2) {
    // No bar grid → render the whole song as one undivided row.
    const leadInPx = options.leadInPx ?? FIXED_LEADIN_DEFAULT;
    const containerW = Math.max(minBarWidthPx + leadInPx, containerWidthPx);
    return [
      {
        startSec: 0,
        endSec: dur,
        startBarNumber: 1,
        widthPx: containerW,
        leadInPx,
        anchors: [
          { sec: 0, x: 0 },
          { sec: dur, x: containerW },
        ],
      },
    ];
  }

  // Auto-scale the lead-in so the pre-bar-1 intro gets horizontal room
  // proportional to its duration relative to a bar — otherwise notes
  // landing before the first detected beat all collide inside a 24 px
  // gutter. Capped at one bar's worth so a very long intro can't dwarf
  // the rest of the row. Caller can opt out via `options.leadInPx`.
  const introDur = Math.max(0, bars[0]);
  const firstBarDur = Math.max(0.001, bars[1] - bars[0]);
  const introRatio = options.leadInPx === undefined ? Math.min(1, introDur / firstBarDur) : 0;

  let leadInPx = options.leadInPx ?? FIXED_LEADIN_DEFAULT;
  const containerW = Math.max(minBarWidthPx + leadInPx, containerWidthPx);
  let barsPerRow: number;
  let barWidthPx: number;
  if (introRatio > 0) {
    // Solve container = leadIn + N*barWidth, leadIn = barWidth*introRatio.
    barsPerRow = Math.max(1, Math.floor(containerW / minBarWidthPx - introRatio));
    barWidthPx = containerW / (barsPerRow + introRatio);
    if (barWidthPx >= minBarWidthPx) {
      leadInPx = Math.max(FIXED_LEADIN_DEFAULT, barWidthPx * introRatio);
      // If clamping pulled lead-in up to the floor, re-derive bar
      // width so the row total still equals the container.
      if (leadInPx > barWidthPx * introRatio) {
        barWidthPx = (containerW - leadInPx) / barsPerRow;
      }
    } else {
      // Tight container: keep bars at minBar and absorb leftover into
      // the lead-in (still at least the default margin).
      barWidthPx = minBarWidthPx;
      leadInPx = Math.max(FIXED_LEADIN_DEFAULT, containerW - barsPerRow * barWidthPx);
      barWidthPx = (containerW - leadInPx) / barsPerRow;
    }
  } else {
    const usable = Math.max(minBarWidthPx, containerW - leadInPx);
    barsPerRow = Math.max(1, Math.floor(usable / minBarWidthPx));
    barWidthPx = usable / barsPerRow;
  }

  const rows: PlannedSystem[] = [];
  for (let firstBar = 0; firstBar < bars.length; firstBar += barsPerRow) {
    const lastBar = Math.min(firstBar + barsPerRow, bars.length);
    const isFirst = firstBar === 0;
    // First row absorbs the pre-bar-1 intro; later rows start at a bar
    // boundary so they have nothing to put in the lead-in space.
    const startSec = isFirst ? 0 : bars[firstBar];
    const endSec = lastBar < bars.length ? bars[lastBar] : dur;

    // Anchor list: lead-in start + lead-in end (= bar `firstBar`) + each
    // subsequent bar boundary in this row + the row's right edge.
    const anchors: { sec: number; x: number }[] = [];
    anchors.push({ sec: startSec, x: 0 });
    if (isFirst) {
      // Intro segment: maps [0, bars[0]] → [0, leadInPx]. Skip the lead
      // anchor when bars[0] is exactly 0 (no intro to render).
      if (bars[0] > 0) anchors.push({ sec: bars[0], x: leadInPx });
    } else {
      anchors.push({ sec: startSec, x: leadInPx });
    }
    for (let i = firstBar + 1; i < lastBar; i++) {
      const localBar = i - firstBar;
      anchors.push({ sec: bars[i], x: leadInPx + localBar * barWidthPx });
    }
    anchors.push({ sec: endSec, x: leadInPx + (lastBar - firstBar) * barWidthPx });

    rows.push({
      startSec,
      endSec,
      startBarNumber: firstBar + 1,
      widthPx: leadInPx + (lastBar - firstBar) * barWidthPx,
      leadInPx,
      anchors,
    });
  }
  return rows;
}

/**
 * Convert a time within `system` to an x-coordinate using piecewise
 * linear interpolation across the system's anchor list. Times outside
 * `[system.startSec, system.endSec)` clamp to the row's edges.
 */
export function rowTimeToX(system: PlannedSystem, time: number): number {
  const a = system.anchors;
  if (a.length === 0) return 0;
  if (time <= a[0].sec) return a[0].x;
  if (time >= a[a.length - 1].sec) return a[a.length - 1].x;
  for (let i = 1; i < a.length; i++) {
    if (time < a[i].sec) {
      const span = a[i].sec - a[i - 1].sec;
      if (span <= 0) return a[i - 1].x;
      const frac = (time - a[i - 1].sec) / span;
      return a[i - 1].x + frac * (a[i].x - a[i - 1].x);
    }
  }
  return a[a.length - 1].x;
}

/** Inverse of `rowTimeToX` — used to translate clicks back to song time. */
export function rowXToTime(system: PlannedSystem, x: number): number {
  const a = system.anchors;
  if (a.length === 0) return 0;
  if (x <= a[0].x) return a[0].sec;
  if (x >= a[a.length - 1].x) return a[a.length - 1].sec;
  for (let i = 1; i < a.length; i++) {
    if (x < a[i].x) {
      const span = a[i].x - a[i - 1].x;
      if (span <= 0) return a[i - 1].sec;
      const frac = (x - a[i - 1].x) / span;
      return a[i - 1].sec + frac * (a[i].sec - a[i - 1].sec);
    }
  }
  return a[a.length - 1].sec;
}

/**
 * Pack the song's bars into a vertical stack of systems, each fitting
 * inside `containerWidthPx`. Greedy: keep adding bars to the current
 * system until the next one would overflow, then start a new system.
 *
 * The first system always starts at song-time 0 (so an intro before
 * bar 1 is rendered on the first row), and the last system extends to
 * `durationSec` (so the tail after the final detected bar still shows
 * up). Each system always contains at least one bar segment, even if
 * that segment alone exceeds the container width — better to overflow
 * one row than to produce an infinite split loop.
 */
export function splitIntoSystems(
  durationSec: number,
  bars: readonly number[],
  layout: TabLayout,
  containerWidthPx: number,
): TabSystem[] {
  const dur = Math.max(0, durationSec);
  const w = Math.max(50, containerWidthPx);
  if (dur <= 0) return [];

  if (bars.length === 0) {
    return [
      {
        startSec: 0,
        endSec: dur,
        startBarNumber: 1,
        widthPx: dur * layout.pixelsPerSecond,
      },
    ];
  }

  const pps = layout.pixelsPerSecond;
  const systems: TabSystem[] = [];
  let iStart = 0; // bar index where the current system starts
  while (iStart < bars.length) {
    // First system starts at 0 to include any intro before bar 1.
    const sysStart = iStart === 0 ? 0 : bars[iStart];

    // Greedily extend by one bar at a time while the resulting system
    // still fits the container. Always include at least one bar, even
    // if it overflows on its own.
    let iEnd = iStart;
    while (iEnd + 1 < bars.length) {
      const tryEnd = iEnd + 2 < bars.length ? bars[iEnd + 2] : dur;
      if ((tryEnd - sysStart) * pps > w) break;
      iEnd++;
    }

    const sysEnd = iEnd + 1 < bars.length ? bars[iEnd + 1] : dur;
    systems.push({
      startSec: sysStart,
      endSec: sysEnd,
      startBarNumber: iStart + 1,
      widthPx: (sysEnd - sysStart) * pps,
    });
    iStart = iEnd + 1;
  }

  return systems;
}
