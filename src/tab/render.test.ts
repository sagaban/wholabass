import { describe, expect, test } from "vitest";
import {
  barLineTimes,
  DEFAULT_LAYOUT,
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
