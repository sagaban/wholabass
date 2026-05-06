import { describe, expect, test } from "vitest";
import { Midi } from "@tonejs/midi";
import {
  describeMidiTracks,
  extractTrackToMidi,
  findBestAlignment,
  suggestBassTrack,
} from "./midi";

function buildMidi(
  tracks: {
    name: string;
    program?: number;
    notes: { midi: number; time: number; duration: number }[];
  }[],
): ArrayBuffer {
  const m = new Midi();
  for (const cfg of tracks) {
    const t = m.addTrack();
    t.name = cfg.name;
    if (cfg.program !== undefined) t.instrument.number = cfg.program;
    for (const n of cfg.notes) {
      t.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: 0.8 });
    }
  }
  // m.toArray() returns a Uint8Array; copy into a fresh ArrayBuffer so
  // the caller can re-parse it as if it came from disk.
  const bytes = m.toArray();
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

describe("describeMidiTracks", () => {
  test("reports name, count, range, and GM bass flag per track", () => {
    const buf = buildMidi([
      {
        name: "Lead",
        program: 30, // distortion guitar
        notes: [
          { midi: 60, time: 0, duration: 0.25 },
          { midi: 72, time: 0.5, duration: 0.25 },
        ],
      },
      {
        name: "Bass",
        program: 33, // electric bass (finger)
        notes: [
          { midi: 40, time: 0, duration: 0.5 },
          { midi: 45, time: 0.5, duration: 0.5 },
          { midi: 38, time: 1.0, duration: 0.5 },
        ],
      },
    ]);
    const tracks = describeMidiTracks(buf);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      name: "Lead",
      noteCount: 2,
      pitchRange: [60, 72],
      programIsBass: false,
    });
    expect(tracks[1]).toMatchObject({
      name: "Bass",
      noteCount: 3,
      pitchRange: [38, 45],
      programIsBass: true,
    });
  });

  test("falls back to 'Track N' when track has no name", () => {
    const buf = buildMidi([{ name: "", notes: [{ midi: 40, time: 0, duration: 1 }] }]);
    expect(describeMidiTracks(buf)[0].name).toBe("Track 1");
  });

  test("empty track has null pitch range", () => {
    const buf = buildMidi([{ name: "Empty", notes: [] }]);
    expect(describeMidiTracks(buf)[0].pitchRange).toBeNull();
  });
});

describe("suggestBassTrack", () => {
  test("picks the GM-bass-flagged track when present", () => {
    const tracks = [
      {
        index: 0,
        name: "Lead",
        noteCount: 50,
        pitchRange: [60, 72] as [number, number],
        program: 30,
        programIsBass: false,
      },
      {
        index: 1,
        name: "Bass",
        noteCount: 5,
        pitchRange: [40, 50] as [number, number],
        program: 33,
        programIsBass: true,
      },
    ];
    expect(suggestBassTrack(tracks)).toBe(1);
  });

  test("falls back to the track most centred in the bass band", () => {
    const tracks = [
      {
        index: 0,
        name: "Vocals",
        noteCount: 20,
        pitchRange: [70, 80] as [number, number],
        program: 0,
        programIsBass: false,
      },
      {
        index: 1,
        name: "Bass-ish",
        noteCount: 30,
        pitchRange: [33, 50] as [number, number],
        program: 0,
        programIsBass: false,
      },
    ];
    expect(suggestBassTrack(tracks)).toBe(1);
  });

  test("ignores empty tracks", () => {
    const tracks = [
      { index: 0, name: "Empty", noteCount: 0, pitchRange: null, program: 0, programIsBass: false },
      {
        index: 1,
        name: "Bass",
        noteCount: 4,
        pitchRange: [40, 50] as [number, number],
        program: 33,
        programIsBass: true,
      },
    ];
    expect(suggestBassTrack(tracks)).toBe(1);
  });

  test("empty input returns 0", () => {
    expect(suggestBassTrack([])).toBe(0);
  });
});

describe("extractTrackToMidi", () => {
  test("keeps only the chosen track, preserving notes", () => {
    const buf = buildMidi([
      { name: "Lead", notes: [{ midi: 60, time: 0, duration: 0.25 }] },
      {
        name: "Bass",
        notes: [
          { midi: 40, time: 0, duration: 0.5 },
          { midi: 45, time: 0.5, duration: 0.5 },
        ],
      },
    ]);
    const out = extractTrackToMidi(buf, 1);
    const re = new Midi(out);
    expect(re.tracks).toHaveLength(1);
    expect(re.tracks[0].name).toBe("Bass");
    expect(re.tracks[0].notes.map((n) => n.midi)).toEqual([40, 45]);
  });

  test("throws on out-of-range index", () => {
    const buf = buildMidi([{ name: "X", notes: [{ midi: 40, time: 0, duration: 1 }] }]);
    expect(() => extractTrackToMidi(buf, 5)).toThrow(/out of range/);
    expect(() => extractTrackToMidi(buf, -1)).toThrow(/out of range/);
  });
});

describe("findBestAlignment", () => {
  test("recovers a known offset (speed=1, offset=2.0s)", () => {
    // MIDI onsets every 0.5s starting at 0; audio onsets shifted by +2.0s.
    const midi = [0, 0.5, 1, 1.5, 2, 2.5, 3];
    const audio = midi.map((t) => t + 2.0);
    const out = findBestAlignment(audio, midi, 1.0);
    expect(out).not.toBeNull();
    expect(out!.speed).toBeCloseTo(1.0, 1);
    // Offset is within the coarse-grid step (50 ms), which is well
    // inside the matching tolerance — the test only checks that we
    // landed in the right neighbourhood.
    expect(Math.abs(out!.offset - 2.0)).toBeLessThanOrEqual(0.06);
    // All midi onsets should match.
    expect(out!.matches).toBe(midi.length);
  });

  test("recovers a small speed deviation", () => {
    // Audio is 5% faster than MIDI: audio[t] = midi[t] / 1.05.
    const midi = Array.from({ length: 20 }, (_, i) => i * 0.5);
    const audio = midi.map((t) => t / 1.05);
    const out = findBestAlignment(audio, midi, 1.0, { offsetMin: -0.5, offsetMax: 0.5 });
    expect(out).not.toBeNull();
    expect(out!.speed).toBeCloseTo(1.05, 1);
  });

  test("returns null on empty input", () => {
    expect(findBestAlignment([], [1, 2, 3], 1)).toBeNull();
    expect(findBestAlignment([1, 2, 3], [], 1)).toBeNull();
  });
});
