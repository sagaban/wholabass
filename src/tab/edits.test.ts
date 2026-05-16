import { describe, expect, test } from "vitest";
import {
  DEFAULT_MIXER,
  EMPTY_EDITS,
  addCut,
  addSection,
  applyCutsToNotes,
  applyEdits,
  applyNoteEditsToBass,
  noteId,
  normalizeMixerState,
  removeCutAt,
  removeSectionAt,
  tabNoteId,
  updateSectionAt,
  upsertEdit,
  type CutSpan,
  type EditOp,
  type EditsFile,
  type SectionLabel,
} from "./edits";
import type { TabNote } from "./optimizer";
import type { BassNote } from "@/audio/midi";

const tn = (startSec: number, pitch: number, string: number, fret: number): TabNote => ({
  startSec,
  pitch,
  durSec: 0.25,
  velocity: 1,
  string,
  fret,
});

describe("noteId", () => {
  test("formats with 4 decimal places", () => {
    expect(noteId(0, 40)).toBe("0.0000-40");
    expect(noteId(1.5, 40)).toBe("1.5000-40");
    expect(noteId(0.123456, 40)).toBe("0.1235-40");
  });

  test("tabNoteId is consistent with noteId", () => {
    const note = tn(1.5, 40, 0, 5);
    expect(tabNoteId(note)).toBe(noteId(1.5, 40));
  });
});

describe("applyEdits", () => {
  const notes: readonly TabNote[] = [tn(0, 40, 0, 0), tn(0.5, 45, 1, 0), tn(1.0, 50, 2, 0)];

  test("returns a copy when there are no edits", () => {
    const out = applyEdits(notes, EMPTY_EDITS);
    expect(out).toEqual(notes);
    expect(out).not.toBe(notes);
  });

  test("replace overrides string/fret on the matched note", () => {
    const edits: EditsFile = {
      version: 1,
      notes: [{ kind: "replace", id: noteId(0.5, 45), string: 2, fret: 7 }],
      sections: [],
    };
    const out = applyEdits(notes, edits);
    expect(out[1]).toMatchObject({ pitch: 45, string: 2, fret: 7 });
    // Other notes untouched.
    expect(out[0]).toMatchObject({ pitch: 40, string: 0, fret: 0 });
  });

  test("delete removes the matched note", () => {
    const edits: EditsFile = {
      version: 1,
      notes: [{ kind: "delete", id: noteId(0.5, 45) }],
      sections: [],
    };
    const out = applyEdits(notes, edits);
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.pitch)).toEqual([40, 50]);
  });

  test("add appends a new note and re-sorts by startSec", () => {
    const edits: EditsFile = {
      version: 1,
      notes: [
        {
          kind: "add",
          id: noteId(0.25, 42),
          pitch: 42,
          startSec: 0.25,
          durSec: 0.25,
          velocity: 1,
          string: 1,
          fret: 9,
        },
      ],
      sections: [],
    };
    const out = applyEdits(notes, edits);
    expect(out.map((n) => n.startSec)).toEqual([0, 0.25, 0.5, 1.0]);
    expect(out[1]).toMatchObject({ pitch: 42, string: 1, fret: 9 });
  });

  test("orphan replace/delete (id not in notes) is a no-op", () => {
    const edits: EditsFile = {
      version: 1,
      notes: [
        { kind: "replace", id: "9.9999-99", string: 0, fret: 0 },
        { kind: "delete", id: "9.9999-99" },
      ],
      sections: [],
    };
    expect(applyEdits(notes, edits)).toEqual(notes);
  });
});

describe("upsertEdit", () => {
  test("a replace replaces a previous replace for the same id", () => {
    const a: EditOp = { kind: "replace", id: "0-40", string: 0, fret: 5 };
    const b: EditOp = { kind: "replace", id: "0-40", string: 1, fret: 0 };
    const out = upsertEdit([a], b);
    expect(out).toEqual([b]);
  });

  test("delete on a previously-added note cancels both ops", () => {
    const add: EditOp = {
      kind: "add",
      id: "1-42",
      pitch: 42,
      startSec: 1,
      durSec: 0.25,
      string: 0,
      fret: 0,
    };
    const del: EditOp = { kind: "delete", id: "1-42" };
    expect(upsertEdit([add], del)).toEqual([]);
  });

  test("delete on an existing-MIDI note becomes a delete op", () => {
    const replace: EditOp = { kind: "replace", id: "0-40", string: 0, fret: 5 };
    const del: EditOp = { kind: "delete", id: "0-40" };
    // Replace gets superseded by the delete, since the note is now gone.
    expect(upsertEdit([replace], del)).toEqual([del]);
  });

  test("operations on different ids coexist", () => {
    const a: EditOp = { kind: "replace", id: "0-40", string: 0, fret: 5 };
    const b: EditOp = { kind: "delete", id: "0.5-45" };
    expect(upsertEdit([a], b)).toEqual([a, b]);
  });

  test("replace on an added note updates the add op's placement (not a separate replace)", () => {
    // Without this, the replace would target an optimizer note that doesn't
    // exist for an added id, and applyEdits would silently drop both ops →
    // the user-added note would vanish on the first re-pick of its alternate.
    const add: EditOp = {
      kind: "add",
      id: "1-42",
      pitch: 42,
      startSec: 1,
      durSec: 0.25,
      string: 0,
      fret: 7,
    };
    const replace: EditOp = { kind: "replace", id: "1-42", string: 1, fret: 2 };
    const out = upsertEdit([add], replace);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "add", string: 1, fret: 2, pitch: 42 });
  });
});

describe("addSection / removeSectionAt", () => {
  const a: SectionLabel = { startSec: 8, endSec: 16, name: "Verse", repeats: 1 };
  const b: SectionLabel = { startSec: 0, endSec: 8, name: "Intro" };
  const c: SectionLabel = { startSec: 16, endSec: 24, name: "Chorus", repeats: 2 };

  test("addSection inserts and sorts by startSec", () => {
    const out = addSection([a], b);
    expect(out.map((s) => s.name)).toEqual(["Intro", "Verse"]);
  });

  test("addSection chains preserve sort order", () => {
    const out = addSection(addSection([a], b), c);
    expect(out.map((s) => s.name)).toEqual(["Intro", "Verse", "Chorus"]);
  });

  test("removeSectionAt removes by index", () => {
    const out = removeSectionAt([b, a, c], 1);
    expect(out.map((s) => s.name)).toEqual(["Intro", "Chorus"]);
  });

  test("removeSectionAt is a no-op for out-of-range indices", () => {
    expect(removeSectionAt([a], -1)).toEqual([a]);
    expect(removeSectionAt([a], 99)).toEqual([a]);
  });

  test("updateSectionAt patches one field, preserves order", () => {
    const out = updateSectionAt([b, a, c], 1, { repeats: 4 });
    expect(out.map((s) => s.name)).toEqual(["Intro", "Verse", "Chorus"]);
    expect(out[1].repeats).toBe(4);
    // Untouched.
    expect(out[0]).toEqual(b);
    expect(out[2]).toEqual(c);
  });

  test("updateSectionAt is a no-op for out-of-range indices", () => {
    expect(updateSectionAt([a], -1, { name: "x" })).toEqual([a]);
    expect(updateSectionAt([a], 99, { name: "x" })).toEqual([a]);
  });
});

const bn = (startSec: number, pitch: number): BassNote => ({
  startSec,
  pitch,
  durSec: 0.25,
  velocity: 1,
});

describe("addCut / removeCutAt", () => {
  test("addCut appends in order (sequential semantics, no merge)", () => {
    const out = addCut([{ startSec: 0, endSec: 2 }], { startSec: 1, endSec: 3 });
    expect(out).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 1, endSec: 3 },
    ]);
  });
  test("addCut ignores zero-length / inverted spans", () => {
    const cuts = [{ startSec: 0, endSec: 2 }];
    expect(addCut(cuts, { startSec: 5, endSec: 5 })).toEqual(cuts);
    expect(addCut(cuts, { startSec: 5, endSec: 4 })).toEqual(cuts);
  });
  test("removeCutAt drops the indexed span", () => {
    const cuts: CutSpan[] = [
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
    ];
    expect(removeCutAt(cuts, 0)).toEqual([{ startSec: 2, endSec: 3 }]);
  });
  test("removeCutAt is a no-op for out-of-range indices", () => {
    const cuts: CutSpan[] = [{ startSec: 0, endSec: 1 }];
    expect(removeCutAt(cuts, -1)).toEqual(cuts);
    expect(removeCutAt(cuts, 99)).toEqual(cuts);
  });
});

describe("applyCutsToNotes", () => {
  test("identity when no cuts", () => {
    const notes = [bn(0, 40), bn(1, 41)];
    const out = applyCutsToNotes(notes, []);
    expect(out).toEqual(notes);
    expect(out).not.toBe(notes);
  });
  test("single cut: filters notes inside, shifts later by the cut duration", () => {
    // C-E-G-A one per pulse → ripple delete G[2,3] → C(0)-E(1)-A(2).
    const notes = [bn(0, 40), bn(1, 41), bn(2, 42), bn(3, 43)];
    const cuts: CutSpan[] = [{ startSec: 2, endSec: 3 }];
    const out = applyCutsToNotes(notes, cuts);
    expect(out).toEqual([bn(0, 40), bn(1, 41), bn(2, 43)]);
  });
  test("sequential cuts: each cut applies in the time domain produced by prior cuts", () => {
    // Cut 1 [2,2.5] removes G; H slides into G's slot. View becomes
    // C(0)-E(1)-H(2)-A(2.5). Cut 2 in that domain = [2,2.5] removes
    // H; A slides into H's slot. Final: C(0)-E(1)-A(2).
    const notes = [bn(0, 40), bn(1, 41), bn(2, 42), bn(2.5, 44), bn(3, 43)];
    const cuts: CutSpan[] = [
      { startSec: 2, endSec: 2.5 },
      { startSec: 2, endSec: 2.5 },
    ];
    const out = applyCutsToNotes(notes, cuts);
    expect(out.map((n) => ({ p: n.pitch, t: n.startSec }))).toEqual([
      { p: 40, t: 0 },
      { p: 41, t: 1 },
      { p: 43, t: 2 },
    ]);
  });
  test("non-overlapping cuts in original time fold left correctly", () => {
    const notes = [bn(0, 40), bn(2.5, 41), bn(5, 42), bn(8, 43)];
    // Cut 1 [1,2] (1 s): removes nothing, shifts everything ≥ 2 back by 1.
    // After cut 1: 0, 1.5, 4, 7.
    // Cut 2 [6,7] (1 s) in current view: removes nothing (no note in [6,7)),
    // shifts everything ≥ 7 back by 1. After cut 2: 0, 1.5, 4, 6.
    const cuts: CutSpan[] = [
      { startSec: 1, endSec: 2 },
      { startSec: 6, endSec: 7 },
    ];
    const out = applyCutsToNotes(notes, cuts);
    expect(out.map((n) => n.startSec)).toEqual([0, 1.5, 4, 6]);
  });
  test("preserves non-time fields verbatim (pitch, durSec, velocity)", () => {
    const notes = [bn(3, 50)];
    const cuts: CutSpan[] = [{ startSec: 1, endSec: 2 }];
    const out = applyCutsToNotes(notes, cuts);
    expect(out).toEqual([{ startSec: 2, pitch: 50, durSec: 0.25, velocity: 1 }]);
  });
});

describe("applyNoteEditsToBass", () => {
  test("identity when no ops", () => {
    const notes = [bn(0, 40), bn(1, 41)];
    const out = applyNoteEditsToBass(notes, []);
    expect(out).toEqual(notes);
    expect(out).not.toBe(notes);
  });
  test("filters notes whose id matches a delete op", () => {
    const notes = [bn(0, 40), bn(1, 41), bn(2, 42)];
    const out = applyNoteEditsToBass(notes, [{ kind: "delete", id: noteId(1, 41) }]);
    expect(out.map((n) => n.pitch)).toEqual([40, 42]);
  });
  test("appends add ops as new bass notes", () => {
    const notes = [bn(0, 40)];
    const out = applyNoteEditsToBass(notes, [
      {
        kind: "add",
        id: noteId(0.5, 42),
        pitch: 42,
        startSec: 0.5,
        durSec: 0.25,
        velocity: 0.8,
        string: 0,
        fret: 0,
      },
    ]);
    expect(out.map((n) => ({ p: n.pitch, t: n.startSec, v: n.velocity }))).toEqual([
      { p: 40, t: 0, v: 1 },
      { p: 42, t: 0.5, v: 0.8 },
    ]);
  });
  test("ignores replace ops' string/fret (fingering-only, no playback effect)", () => {
    const notes = [bn(0, 40)];
    const out = applyNoteEditsToBass(notes, [
      { kind: "replace", id: noteId(0, 40), string: 1, fret: 5 },
    ]);
    expect(out).toEqual(notes);
  });

  test("replace ops carry articulation onto the bass note", () => {
    const notes = [bn(0, 40)];
    const out = applyNoteEditsToBass(notes, [
      {
        kind: "replace",
        id: noteId(0, 40),
        string: 1,
        fret: 5,
        articulation: { palmMute: true, staccato: true },
      },
    ]);
    expect(out[0].articulation).toEqual({ palmMute: true, staccato: true });
  });

  test("replace without articulation clears any earlier articulation on the note", () => {
    const notes: BassNote[] = [{ ...bn(0, 40), articulation: { accent: true } }];
    const out = applyNoteEditsToBass(notes, [
      { kind: "replace", id: noteId(0, 40), string: 0, fret: 0 },
    ]);
    expect(out[0].articulation).toBeUndefined();
  });
});

describe("normalizeMixerState", () => {
  test("returns null when there's no saved mixer block", () => {
    expect(normalizeMixerState(undefined)).toBeNull();
    expect(normalizeMixerState(null)).toBeNull();
    expect(normalizeMixerState("not an object")).toBeNull();
  });

  test("clamps volumes into [0, 1] and falls back on non-numeric inputs", () => {
    const out = normalizeMixerState({
      vocals: { volume: 1.5, muted: false, soloed: false },
      drums: { volume: -0.2, muted: false, soloed: false },
      bass: { volume: "loud", muted: false, soloed: false },
      other: { volume: 0.7, muted: false, soloed: false },
      midi: { volume: 0.5, muted: false, soloed: false },
      master: 99,
    });
    expect(out?.vocals.volume).toBe(1);
    expect(out?.drums.volume).toBe(0);
    // "loud" → fallback to DEFAULT_MIXER.bass.volume (= 1).
    expect(out?.bass.volume).toBe(1);
    expect(out?.other.volume).toBe(0.7);
    expect(out?.master).toBe(1);
  });

  test("preserves valid mute / solo flags and fills in missing strips", () => {
    const out = normalizeMixerState({
      vocals: { volume: 0.6, muted: true, soloed: false },
      // drums missing entirely → default
    });
    expect(out?.vocals).toEqual({ volume: 0.6, muted: true, soloed: false });
    expect(out?.drums).toEqual(DEFAULT_MIXER.drums);
    expect(out?.midi).toEqual(DEFAULT_MIXER.midi);
  });
});
