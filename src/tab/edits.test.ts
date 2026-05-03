import { describe, expect, test } from "vitest";
import {
  EMPTY_EDITS,
  applyEdits,
  noteId,
  tabNoteId,
  upsertEdit,
  type EditOp,
  type EditsFile,
} from "./edits";
import type { TabNote } from "./optimizer";

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
});
