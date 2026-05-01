import { describe, expect, test } from "vitest";
import type { BassNote } from "@/audio/midi";
import { DEFAULT_TUNING, fingerNotes } from "./optimizer";

function note(pitch: number, startSec = 0, durSec = 0.5): BassNote {
  return { pitch, startSec, durSec, velocity: 1 };
}

const E_STRING = 0;
const D_STRING = 2;
const G_STRING = 3;

describe("fingerNotes", () => {
  test("empty input → empty output", () => {
    expect(fingerNotes([])).toEqual([]);
  });

  test("single low note lands on its only valid string", () => {
    // E1 = 28 is only reachable as fret 0 on the E string.
    const out = fingerNotes([note(28)]);
    expect(out).toHaveLength(1);
    expect(out[0].string).toBe(E_STRING);
    expect(out[0].fret).toBe(0);
  });

  test("single mid note picks the placement closest to the preferred fret", () => {
    // A2 = 45 has placements:
    //   E,17 (>maxFret) → out
    //   A,12, D,7, G,2
    // Preferred fret = 5 → A,12 (dist 7), D,7 (dist 2), G,2 (dist 3).
    // D,7 wins.
    const out = fingerNotes([note(45)]);
    expect(out[0].string).toBe(D_STRING);
    expect(out[0].fret).toBe(7);
  });

  test("ascending E-string scale stays on the E string", () => {
    // E1 .. E2 chromatic. Starting from E,0 (forced), the optimizer should
    // keep climbing the E string instead of switching at fret 5+.
    const pitches = Array.from({ length: 13 }, (_, i) => 28 + i);
    const out = fingerNotes(pitches.map((p) => note(p)));
    for (let i = 0; i < out.length; i++) {
      expect(out[i].string).toBe(E_STRING);
      expect(out[i].fret).toBe(i);
    }
  });

  test("after a low E1, an octave-up E2 picks the closest string", () => {
    // E1 → E2 across an octave. From {E,0}, the cheapest E2 placement is
    // {D,2} (fret diff 2 + string switch 1 = 3) — much closer than {E,12}
    // (fret diff 12) or {A,7} (fret diff 7 + string switch 0.5 = 7.5).
    const out = fingerNotes([note(28, 0), note(40, 1)]);
    expect(out[0]).toMatchObject({ string: E_STRING, fret: 0 });
    expect(out[1]).toMatchObject({ string: D_STRING, fret: 2 });
  });

  test("octaveShift moves the whole sequence off the lowest string", () => {
    // Same chromatic scale, but shifted up an octave (E2..E3). With
    // octaveShift=12 the lowest pitch is E2=40, which can't be played
    // anywhere on the E string within max-fret=12. So nothing should
    // land on the E string anymore.
    const pitches = Array.from({ length: 13 }, (_, i) => 28 + i);
    const baseline = fingerNotes(pitches.map((p) => note(p)));
    const shifted = fingerNotes(
      pitches.map((p) => note(p)),
      { octaveShift: 12 },
    );
    expect(baseline.every((n) => n.string === E_STRING)).toBe(true);
    expect(shifted.some((n) => n.string === E_STRING)).toBe(false);
    // Differing octaveShift produces a different fingering.
    expect(shifted).not.toEqual(baseline);
  });

  test("maxFret clamps available placements", () => {
    // A2 = 45 with maxFret=4 leaves only G,2 as a valid placement
    // (E,17/A,12/D,7 all exceed 4).
    const out = fingerNotes([note(45)], { maxFret: 4 });
    expect(out[0]).toMatchObject({ string: G_STRING, fret: 2 });
  });

  test("unreachable pitch falls back to the closest in-range placement", () => {
    // C5 = 72 with maxFret=12 is unreachable (G string fret would be 29).
    // Optimizer falls back to G,12 (closest to ideal 29 within [0..12]).
    const out = fingerNotes([note(72)]);
    expect(out[0].string).toBe(G_STRING);
    expect(out[0].fret).toBe(12);
  });

  test("default tuning is E1 A1 D2 G2", () => {
    expect([...DEFAULT_TUNING]).toEqual([28, 33, 38, 43]);
  });

  test("re-running with different options is fast (<100ms for 1000 notes)", () => {
    const pitches = Array.from({ length: 1000 }, (_, i) => 30 + (i % 20));
    const notes = pitches.map((p, i) => note(p, i * 0.25));
    const t0 = performance.now();
    fingerNotes(notes);
    fingerNotes(notes, { octaveShift: 12 });
    fingerNotes(notes, { preferredFret: 9 });
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(100);
  });
});
