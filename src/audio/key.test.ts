import { describe, expect, test } from "vitest";
import type { BassNote } from "./midi";
import { estimateKey, pitchClassHistogram } from "./key";

const note = (pitch: number, durSec = 0.5): BassNote => ({
  pitch,
  startSec: 0,
  durSec,
  velocity: 1,
});

describe("pitchClassHistogram", () => {
  test("buckets pitches into 12 pitch classes by duration", () => {
    const h = pitchClassHistogram([
      note(60, 1), // C
      note(72, 1), // C (octave up)
      note(64, 0.5), // E
    ]);
    expect(h[0]).toBeCloseTo(2);
    expect(h[4]).toBeCloseTo(0.5);
    expect(h[7]).toBe(0); // G unused
  });

  test("clamps very-short durations to a small floor so staccato notes still count", () => {
    const h = pitchClassHistogram([note(60, 0.001)]);
    expect(h[0]).toBeGreaterThan(0);
  });
});

describe("estimateKey", () => {
  // C major scale (more roots and 5ths to bias towards C major).
  test("recognises a clean C-major bass line", () => {
    const notes = [
      note(36, 2), // C2 (root, sustained)
      note(43, 1), // G2 (5th)
      note(36, 2),
      note(40, 1), // E2 (3rd)
      note(36, 2),
      note(43, 1),
      note(45, 1), // A2
      note(36, 2),
    ];
    const out = estimateKey(notes);
    expect(out).not.toBeNull();
    expect(out!.tonic).toBe("C");
    expect(out!.mode).toBe("major");
  });

  test("recognises a clean A-minor bass line", () => {
    const notes = [
      note(33, 2), // A1 (root)
      note(40, 1), // E2 (5th)
      note(33, 2),
      note(36, 1), // C2 (minor 3rd)
      note(33, 2),
      note(40, 1),
      note(31, 1), // G1 (minor 7th)
      note(33, 2),
    ];
    const out = estimateKey(notes);
    expect(out).not.toBeNull();
    expect(out!.tonic).toBe("A");
    expect(out!.mode).toBe("minor");
  });

  test("returns null on empty input", () => {
    expect(estimateKey([])).toBeNull();
  });

  test("tonic is invariant to octave (transposing up an octave keeps the key)", () => {
    const lo = [note(36, 2), note(43, 1), note(40, 1), note(36, 2)];
    const hi = lo.map((n) => ({ ...n, pitch: n.pitch + 12 }));
    expect(estimateKey(lo)!.tonic).toBe(estimateKey(hi)!.tonic);
  });
});
