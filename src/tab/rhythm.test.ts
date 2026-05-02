import { describe, expect, test } from "vitest";
import {
  beamGroups,
  beatIndexAt,
  classifyDuration,
  classifyNote,
  localBeatDuration,
  rhythmGlyph,
  type RhythmKind,
} from "./rhythm";
import type { BassNote } from "@/audio/midi";

const BEATS = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]; // 120 BPM grid

describe("beatIndexAt", () => {
  test("clamps below the first beat", () => {
    expect(beatIndexAt(-1, BEATS)).toBe(0);
  });

  test("returns the index whose interval contains time", () => {
    expect(beatIndexAt(0.0, BEATS)).toBe(0);
    expect(beatIndexAt(0.4, BEATS)).toBe(0);
    expect(beatIndexAt(0.5, BEATS)).toBe(1);
    expect(beatIndexAt(2.4, BEATS)).toBe(4);
  });

  test("clamps above the last beat to the final gap", () => {
    expect(beatIndexAt(99, BEATS)).toBe(BEATS.length - 2);
  });

  test("degenerate beats array returns 0", () => {
    expect(beatIndexAt(1.0, [0.0])).toBe(0);
    expect(beatIndexAt(1.0, [])).toBe(0);
  });
});

describe("localBeatDuration", () => {
  test("uniform 120-BPM grid → 0.5", () => {
    expect(localBeatDuration(1.7, BEATS)).toBeCloseTo(0.5, 6);
  });

  test("falls back to 0.5 on too-short array", () => {
    expect(localBeatDuration(1.0, [])).toBe(0.5);
  });

  test("uses the local gap when the grid is irregular", () => {
    const irregular = [0, 0.5, 1.0, 2.0]; // last gap is a 1-second beat (= 60 BPM)
    expect(localBeatDuration(1.5, irregular)).toBe(1.0);
    expect(localBeatDuration(0.7, irregular)).toBe(0.5);
  });
});

describe("classifyDuration", () => {
  const beat = 0.5;
  const cases: ReadonlyArray<readonly [number, RhythmKind]> = [
    [0.5, "quarter"],
    [0.25, "eighth"],
    [0.125, "sixteenth"],
    [0.375, "dottedEighth"],
    [0.75, "dottedQuarter"],
    [1.0, "half"],
    [2.0, "whole"],
  ];

  for (const [dur, kind] of cases) {
    test(`${dur}s @ 120BPM → ${kind}`, () => {
      expect(classifyDuration(dur, beat)).toBe(kind);
    });
  }

  test("snaps slightly-off durations to the nearest standard value", () => {
    // 270 ms at a 500 ms beat is closer to an eighth (250 ms) than to a
    // dotted-eighth (375 ms) on a log scale.
    expect(classifyDuration(0.27, beat)).toBe("eighth");
    // 0.46 s is much closer to quarter (0.5) than dotted-eighth (0.375).
    expect(classifyDuration(0.46, beat)).toBe("quarter");
  });

  test("very long notes clamp to whole", () => {
    expect(classifyDuration(8.0, beat)).toBe("whole");
  });
});

describe("classifyNote", () => {
  test("uses the beat at the note's start", () => {
    const irregular = [0, 0.5, 1.0, 2.0];
    // Note starts at 1.5 (in the slow 1-second beat) and lasts 0.5 s →
    // half a beat → eighth, NOT quarter (would be quarter under the
    // earlier 0.5-second beat).
    const note = { pitch: 40, startSec: 1.5, durSec: 0.5, velocity: 1 };
    expect(classifyNote(note, irregular)).toBe("eighth");
  });
});

const note = (startSec: number, durSec: number): BassNote => ({
  pitch: 40,
  velocity: 1,
  startSec,
  durSec,
});

describe("beamGroups", () => {
  test("two eighths in the same beat form a level-1 beam group", () => {
    // beat 0..0.5; two eighths at 0 and 0.25 each lasting a quarter-of-a-beat.
    const groups = beamGroups([note(0.0, 0.25), note(0.25, 0.25)], BEATS);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 1]);
    expect(groups[0].beamLevels).toBe(1);
  });

  test("eighths in separate beats are separate groups", () => {
    const groups = beamGroups(
      [note(0.0, 0.25), note(0.25, 0.25), note(0.5, 0.25), note(0.75, 0.25)],
      BEATS,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].indices).toEqual([0, 1]);
    expect(groups[1].indices).toEqual([2, 3]);
  });

  test("a quarter splits a beat", () => {
    // eighth-quarter-eighth: two singletons + a quarter in between.
    const notes = [note(0.0, 0.25), note(0.5, 0.5), note(1.0, 0.25)];
    const groups = beamGroups(notes, BEATS);
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      expect(g.indices).toHaveLength(1);
    }
    // The quarter is level 0; the singleton eighths are level 1.
    expect(groups[0].beamLevels).toBe(1);
    expect(groups[1].beamLevels).toBe(0);
    expect(groups[2].beamLevels).toBe(1);
  });

  test("mixed eighths + sixteenths take the max level", () => {
    const groups = beamGroups([note(0.0, 0.25), note(0.25, 0.125), note(0.375, 0.125)], BEATS);
    expect(groups).toHaveLength(1);
    expect(groups[0].indices).toEqual([0, 1, 2]);
    expect(groups[0].beamLevels).toBe(2);
  });

  test("empty input is empty", () => {
    expect(beamGroups([], BEATS)).toEqual([]);
  });
});

describe("rhythmGlyph", () => {
  test("eighth has one flag, sixteenth has two", () => {
    expect(rhythmGlyph("eighth").flags).toBe(1);
    expect(rhythmGlyph("sixteenth").flags).toBe(2);
    expect(rhythmGlyph("quarter").flags).toBe(0);
  });

  test("dotted variants have dotted=true", () => {
    expect(rhythmGlyph("dottedEighth").dotted).toBe(true);
    expect(rhythmGlyph("dottedQuarter").dotted).toBe(true);
    expect(rhythmGlyph("eighth").dotted).toBe(false);
  });

  test("shortNote gates whether to draw a stem at all", () => {
    expect(rhythmGlyph("eighth").shortNote).toBe(true);
    expect(rhythmGlyph("sixteenth").shortNote).toBe(true);
    expect(rhythmGlyph("quarter").shortNote).toBe(false);
    expect(rhythmGlyph("dottedQuarter").shortNote).toBe(false);
  });
});
