import { describe, expect, test } from "vitest";
import { preferFlatsForLyrics, transposeChord } from "./chords";

describe("transposeChord", () => {
  test("zero semitones returns input verbatim", () => {
    expect(transposeChord("Am7", 0, false)).toBe("Am7");
    expect(transposeChord("Do(maj7)", 0, true)).toBe("Do(maj7)");
  });

  test("english root: simple +2 (whole step up)", () => {
    expect(transposeChord("A", 2, false)).toBe("B");
    expect(transposeChord("C", 2, false)).toBe("D");
    expect(transposeChord("Am7", 2, false)).toBe("Bm7");
  });

  test("english root: accidental direction respected", () => {
    expect(transposeChord("C", 1, false)).toBe("C#");
    expect(transposeChord("C", 1, true)).toBe("Db");
    expect(transposeChord("Bb", 2, true)).toBe("C");
    expect(transposeChord("F#", -1, false)).toBe("F");
  });

  test("solfège root stays in solfège", () => {
    expect(transposeChord("Lam7", 2, false)).toBe("Sim7");
    expect(transposeChord("Do", 1, false)).toBe("Do#");
    expect(transposeChord("Do", 1, true)).toBe("Reb");
    expect(transposeChord("Sol", 5, true)).toBe("Do");
  });

  test("slash bass transposes too, preserving notation style", () => {
    expect(transposeChord("G/B", 2, false)).toBe("A/C#");
    expect(transposeChord("G/B", 2, true)).toBe("A/Db");
    expect(transposeChord("Lam7/Re", 2, false)).toBe("Sim7/Mi");
  });

  test("complex suffixes pass through unchanged", () => {
    expect(transposeChord("Cmaj7", 2, false)).toBe("Dmaj7");
    expect(transposeChord("Do(maj7)", 2, false)).toBe("Re(maj7)");
    expect(transposeChord("Am7(b5)", 3, false)).toBe("Cm7(b5)");
    expect(transposeChord("F#m7b5", -1, false)).toBe("Fm7b5");
  });

  test("wraps around the octave correctly", () => {
    expect(transposeChord("B", 1, false)).toBe("C");
    expect(transposeChord("C", -1, true)).toBe("B");
    expect(transposeChord("A", 12, false)).toBe("A");
    expect(transposeChord("Si", 1, false)).toBe("Do");
  });

  test("non-parseable input is returned verbatim", () => {
    expect(transposeChord("hello", 2, false)).toBe("hello");
    expect(transposeChord("", 2, false)).toBe("");
  });
});

describe("preferFlatsForLyrics", () => {
  test("majority flats → prefer flats", () => {
    expect(preferFlatsForLyrics("Bb Eb Ab F")).toBe(true);
  });
  test("majority sharps → prefer sharps", () => {
    expect(preferFlatsForLyrics("F#m C#m G#m B")).toBe(false);
  });
  test("no accidentals → defaults to flats", () => {
    expect(preferFlatsForLyrics("Am Dm G C")).toBe(true);
  });
  test("tie → flats (matches the default)", () => {
    expect(preferFlatsForLyrics("Bb F#")).toBe(true);
  });
});
