import { describe, expect, test } from "vitest";
import {
  barLineTimes,
  DEFAULT_LAYOUT,
  planSystems,
  rowTimeToX,
  rowXToTime,
  splitIntoSystems,
  staffHeight,
  stringIndexToY,
  timeToX,
  totalHeight,
  totalWidth,
  xToTime,
  type TabLayout,
} from "./render";

const L: TabLayout = {
  pixelsPerSecond: 100,
  stringLineSpacing: 20,
  topPadding: 30,
  bottomPadding: 20,
  beatsPerBar: 4,
  stringCount: 4,
};

describe("render layout helpers", () => {
  test("timeToX scales seconds to pixels", () => {
    expect(timeToX(0, L)).toBe(0);
    expect(timeToX(1.5, L)).toBe(150);
    expect(timeToX(60, L)).toBe(6000);
  });

  test("xToTime is the inverse of timeToX", () => {
    for (const t of [0, 0.5, 12.34, 240]) {
      expect(xToTime(timeToX(t, L), L)).toBeCloseTo(t, 6);
    }
  });

  test("stringIndexToY: G on top, E on bottom", () => {
    // 4 strings, spacing 20, topPadding 30:
    // string 3 (G) → fromTop 0 → y 30
    // string 2 (D) → fromTop 1 → y 50
    // string 1 (A) → fromTop 2 → y 70
    // string 0 (E) → fromTop 3 → y 90
    expect(stringIndexToY(3, L)).toBe(30);
    expect(stringIndexToY(2, L)).toBe(50);
    expect(stringIndexToY(1, L)).toBe(70);
    expect(stringIndexToY(0, L)).toBe(90);
  });

  test("staffHeight and totalHeight", () => {
    expect(staffHeight(L)).toBe(60); // 3 gaps × 20
    expect(totalHeight(L)).toBe(110); // 30 + 60 + 20
  });

  test("totalWidth clamps at zero for negative durations", () => {
    expect(totalWidth(0, L)).toBe(0);
    expect(totalWidth(-3, L)).toBe(0);
    expect(totalWidth(2, L)).toBe(200);
  });

  test("barLineTimes picks every Nth beat", () => {
    const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    expect(barLineTimes(beats, 4)).toEqual([0, 2, 4]);
    expect(barLineTimes(beats, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(barLineTimes([], 4)).toEqual([]);
    expect(barLineTimes(beats, 0)).toEqual([]);
  });

  test("DEFAULT_LAYOUT is sane", () => {
    expect(DEFAULT_LAYOUT.stringCount).toBe(4);
    expect(DEFAULT_LAYOUT.beatsPerBar).toBe(4);
    expect(DEFAULT_LAYOUT.pixelsPerSecond).toBeGreaterThan(0);
  });
});

describe("splitIntoSystems", () => {
  // Layout used in the helper tests: 100 px/sec.
  // Bars at every 1s → bar width = 100 px.
  const SHORT = L;

  test("empty bars → one system spanning the whole song", () => {
    const out = splitIntoSystems(10, [], SHORT, 600);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      startSec: 0,
      endSec: 10,
      startBarNumber: 1,
      widthPx: 1000,
    });
  });

  test("packs bars greedily into rows fitting the container", () => {
    // 10 bars at 1s each (= 100 px each); container 350 px → 3 bars/row
    // (4 bars would be 400 > 350).
    const bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = splitIntoSystems(10, bars, SHORT, 350);
    // Bars 1-3, 4-6, 7-9, then a final tail-only system from bar 10
    // (bars[9]) to durationSec=10.
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[0]).toMatchObject({ startSec: 0, endSec: 3, startBarNumber: 1 });
    expect(out[1]).toMatchObject({ startSec: 3, endSec: 6, startBarNumber: 4 });
    expect(out[2]).toMatchObject({ startSec: 6, endSec: 9, startBarNumber: 7 });
    // Final system reaches duration.
    expect(out[out.length - 1].endSec).toBe(10);
  });

  test("never produces zero-bar systems even when one bar overflows", () => {
    // 5 bars × 100 px = 500 px each, container only 200 → still 1/row.
    const bars = [0, 1, 2, 3, 4];
    const tinyLayout: TabLayout = { ...SHORT, pixelsPerSecond: 500 };
    const out = splitIntoSystems(5, bars, tinyLayout, 200);
    // Each bar is 500 px wide; container is 200; algorithm guarantees ≥1 bar/row.
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const s of out) {
      expect(s.endSec).toBeGreaterThan(s.startSec);
    }
  });

  test("first system starts at 0 even if bar 1 starts later (intro)", () => {
    // bars[0] = 1.5 (1.5s intro before downbeat). With container big
    // enough for everything, expect a single system spanning [0, 10].
    const bars = [1.5, 2.5, 3.5];
    const out = splitIntoSystems(10, bars, SHORT, 5000);
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBe(0);
    expect(out[0].endSec).toBe(10);
  });

  test("last system extends past the final detected bar", () => {
    // bars at 0,1,2,3 ; song ends at 5. Last system should reach 5.
    const out = splitIntoSystems(5, [0, 1, 2, 3], SHORT, 5000);
    expect(out[out.length - 1].endSec).toBe(5);
  });

  test("widthPx matches startSec/endSec at the layout's pps", () => {
    const out = splitIntoSystems(8, [0, 1, 2, 3, 4, 5, 6, 7], SHORT, 350);
    for (const s of out) {
      expect(s.widthPx).toBeCloseTo((s.endSec - s.startSec) * SHORT.pixelsPerSecond, 6);
    }
  });

  test("zero-or-negative duration → empty list", () => {
    expect(splitIntoSystems(0, [0, 1], SHORT, 1000)).toEqual([]);
    expect(splitIntoSystems(-1, [0, 1], SHORT, 1000)).toEqual([]);
  });
});

describe("planSystems", () => {
  const LAYOUT = L;

  test("empty bars → single undivided row", () => {
    const out = planSystems(10, [], LAYOUT, 1000);
    expect(out).toHaveLength(1);
    expect(out[0].startSec).toBe(0);
    expect(out[0].endSec).toBe(10);
  });

  test("uniform bars-per-row across rows so bar lines align", () => {
    // Override minBarWidthPx to 110 so we get a predictable split for
    // this test independent of the production default.
    const bars = Array.from({ length: 12 }, (_, i) => i);
    const out = planSystems(12, bars, LAYOUT, 600, { minBarWidthPx: 110 });
    // 12 / 5 = 3 rows: 5, 5, 2 bars.
    expect(out).toHaveLength(3);
    expect(out[0].widthPx).toBeCloseTo(out[1].widthPx, 6);
    expect(out[2].widthPx).toBeLessThan(out[0].widthPx);
  });

  test("first row absorbs the pre-bar-1 intro into its lead-in", () => {
    // Intro from 0..2 then bars 1, 2, 3 at 2s, 3s, 4s.
    const out = planSystems(5, [2, 3, 4], LAYOUT, 2000);
    const r1 = out[0];
    expect(r1.startSec).toBe(0);
    expect(r1.anchors[0]).toEqual({ sec: 0, x: 0 });
    const introAnchor = r1.anchors.find((a) => a.sec === 2);
    expect(introAnchor?.x).toBe(r1.leadInPx);
  });

  test("subsequent rows have an empty lead-in (no pre-roll)", () => {
    // 6 bars; pin minBarWidthPx and pick container width so we get exactly 3 bars/row.
    const bars = [0, 1, 2, 3, 4, 5];
    const out = planSystems(6, bars, LAYOUT, 24 + 3 * 110, { minBarWidthPx: 110 });
    expect(out).toHaveLength(2);
    const r2 = out[1];
    expect(r2.startSec).toBe(3);
    expect(r2.anchors[0].x).toBe(0);
    expect(r2.anchors[1].sec).toBe(3);
    expect(r2.anchors[1].x).toBe(r2.leadInPx);
  });

  test("rowTimeToX is piecewise linear and clamps at edges", () => {
    const sys = {
      startSec: 0,
      endSec: 4,
      startBarNumber: 1,
      widthPx: 240,
      leadInPx: 24,
      anchors: [
        { sec: 0, x: 0 },
        { sec: 1, x: 24 },
        { sec: 2, x: 124 }, // bar with twice the duration → same width as previous
        { sec: 4, x: 240 },
      ],
    };
    expect(rowTimeToX(sys, -1)).toBe(0);
    expect(rowTimeToX(sys, 0)).toBe(0);
    expect(rowTimeToX(sys, 0.5)).toBe(12);
    expect(rowTimeToX(sys, 1)).toBe(24);
    expect(rowTimeToX(sys, 1.5)).toBe(74); // halfway through 24..124
    expect(rowTimeToX(sys, 4)).toBe(240);
    expect(rowTimeToX(sys, 99)).toBe(240);
  });

  test("rowXToTime is the inverse of rowTimeToX", () => {
    // One wide row holds all bars so every test time falls inside the
    // first system without clamping at the edges.
    const sys = planSystems(10, [0, 2, 4, 6, 8], LAYOUT, 2000)[0];
    for (const t of [0, 1, 2.5, 5, 7.7]) {
      const back = rowXToTime(sys, rowTimeToX(sys, t));
      expect(back).toBeCloseTo(t, 4);
    }
  });
});
