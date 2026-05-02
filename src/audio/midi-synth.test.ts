import { describe, expect, test } from "vitest";
import type { BassNote } from "@/audio/midi";
import { midiToFreq, notesToSchedule } from "./midi-synth";

const note = (startSec: number, durSec: number, pitch = 40, velocity = 1.0): BassNote => ({
  startSec,
  durSec,
  pitch,
  velocity,
});

describe("notesToSchedule", () => {
  test("maps song-time to ctx-time at tempo=1", () => {
    const notes = [note(0, 0.5), note(1, 0.5), note(2, 0.5)];
    const evts = notesToSchedule(notes, { songOffset: 0, ctxStart: 100, tempo: 1 });
    expect(evts).toHaveLength(3);
    expect(evts[0].ctxStart).toBe(100);
    expect(evts[0].ctxEnd).toBe(100.5);
    expect(evts[1].ctxStart).toBe(101);
    expect(evts[2].ctxStart).toBe(102);
  });

  test("stretches durations and offsets at tempo<1", () => {
    const notes = [note(0, 0.4), note(1, 0.4)];
    const evts = notesToSchedule(notes, { songOffset: 0, ctxStart: 0, tempo: 0.5 });
    // 0.5x tempo → real time is 2x song time.
    expect(evts[0].ctxStart).toBe(0);
    expect(evts[0].ctxEnd).toBe(0.8);
    expect(evts[1].ctxStart).toBe(2);
    expect(evts[1].ctxEnd).toBe(2.8);
  });

  test("songOffset shifts schedule to ctxStart=0", () => {
    const notes = [note(5, 0.5), note(6, 0.5)];
    const evts = notesToSchedule(notes, { songOffset: 5, ctxStart: 10, tempo: 1 });
    expect(evts[0].ctxStart).toBe(10);
    expect(evts[1].ctxStart).toBe(11);
  });

  test("skips notes that ended before songOffset", () => {
    const notes = [note(0, 0.5), note(2, 0.5), note(4, 0.5)];
    const evts = notesToSchedule(notes, { songOffset: 3, ctxStart: 0, tempo: 1 });
    expect(evts).toHaveLength(1);
    expect(evts[0].pitch).toBe(40);
    expect(evts[0].ctxStart).toBe(1);
  });

  test("clips a note that overlaps songOffset to start at ctxStart", () => {
    // note from t=2 to t=4, songOffset=3 → should fire at ctxStart with half its body left.
    const evts = notesToSchedule([note(2, 2)], { songOffset: 3, ctxStart: 0, tempo: 1 });
    expect(evts).toHaveLength(1);
    expect(evts[0].ctxStart).toBe(0);
    expect(evts[0].ctxEnd).toBe(1);
  });

  test("songEnd cuts off later notes", () => {
    const notes = [note(0, 0.5), note(2, 0.5), note(4, 0.5)];
    const evts = notesToSchedule(notes, { songOffset: 0, ctxStart: 0, tempo: 1, songEnd: 3 });
    expect(evts).toHaveLength(2);
  });

  test("tempo<=0 returns empty", () => {
    expect(notesToSchedule([note(0, 1)], { songOffset: 0, ctxStart: 0, tempo: 0 })).toEqual([]);
  });

  test("peakGain scales with velocity but has a floor", () => {
    const evts = notesToSchedule(
      [note(0, 0.1, 40, 0.0), note(0.2, 0.1, 40, 0.5), note(0.4, 0.1, 40, 1.0)],
      { songOffset: 0, ctxStart: 0, tempo: 1 },
    );
    // Floor 0.2 × scale 0.3 = 0.06
    expect(evts[0].peakGain).toBeCloseTo(0.06, 6);
    expect(evts[1].peakGain).toBeCloseTo(0.15, 6);
    expect(evts[2].peakGain).toBeCloseTo(0.3, 6);
  });
});

describe("midiToFreq", () => {
  test("A4 (69) → 440Hz", () => {
    expect(midiToFreq(69)).toBe(440);
  });

  test("E1 (28) ≈ 41.2Hz", () => {
    expect(midiToFreq(28)).toBeCloseTo(41.2, 1);
  });

  test("octaves double", () => {
    expect(midiToFreq(40)).toBeCloseTo(midiToFreq(28) * 2, 6);
  });
});
