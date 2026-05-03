/**
 * Edits overlay schema + apply logic.
 *
 * The optimizer produces a fresh `TabNote[]` from the MIDI every time
 * the user opens a song; user edits live separately in
 * `library/<id>/bass.tab.edits.json` and are applied as a second pass
 * so re-running the optimizer (e.g., after a parameter tweak) keeps
 * the edits whose target note still exists.
 *
 * Note identity: `id = "${startSec.toFixed(4)}-${pitch}"`. Stable across
 * optimizer re-runs (which only change string/fret), breaks only if the
 * underlying MIDI is re-transcribed.
 */

import type { TabNote } from "@/tab/optimizer";

export const EDITS_VERSION = 1;

export type NoteId = string;

export type EditOp =
  | { kind: "replace"; id: NoteId; string: number; fret: number }
  | { kind: "delete"; id: NoteId }
  | {
      kind: "add";
      id: NoteId;
      pitch: number;
      startSec: number;
      durSec: number;
      string: number;
      fret: number;
      velocity?: number;
    };

export interface SectionLabel {
  startBeat: number;
  endBeat: number;
  name: string;
  repeats?: number;
}

export interface EditsFile {
  version: number;
  notes: EditOp[];
  sections: SectionLabel[];
}

export const EMPTY_EDITS: EditsFile = { version: EDITS_VERSION, notes: [], sections: [] };

export function noteId(startSec: number, pitch: number): NoteId {
  return `${startSec.toFixed(4)}-${pitch}`;
}

export function tabNoteId(n: { startSec: number; pitch: number }): NoteId {
  return noteId(n.startSec, n.pitch);
}

/**
 * Return a new TabNote[] with edits applied. Replaces and deletes
 * match by id; orphan ops (target note no longer exists) are silently
 * dropped. Add ops are appended and the result re-sorted by start time
 * so the rest of the renderer can keep its "sorted" assumption.
 */
export function applyEdits(notes: readonly TabNote[], edits: EditsFile): TabNote[] {
  if (edits.notes.length === 0) return notes.slice();

  const replaceById = new Map<NoteId, EditOp & { kind: "replace" }>();
  const deleteIds = new Set<NoteId>();
  const additions: TabNote[] = [];

  for (const op of edits.notes) {
    if (op.kind === "replace") replaceById.set(op.id, op);
    else if (op.kind === "delete") deleteIds.add(op.id);
    else if (op.kind === "add") {
      additions.push({
        pitch: op.pitch,
        startSec: op.startSec,
        durSec: op.durSec,
        velocity: op.velocity ?? 1,
        string: op.string,
        fret: op.fret,
      });
    }
  }

  const out: TabNote[] = [];
  for (const n of notes) {
    const id = tabNoteId(n);
    if (deleteIds.has(id)) continue;
    const r = replaceById.get(id);
    if (r) {
      out.push({ ...n, string: r.string, fret: r.fret });
    } else {
      out.push(n);
    }
  }
  for (const n of additions) out.push(n);
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

/**
 * Replace the in-memory edits list so a `replace` for the same note id
 * supersedes any older op (we never want two replaces for the same note).
 * `delete` of a previously-`add`ed note removes the add instead. Returns
 * a new array — caller substitutes it into the EditsFile.
 */
export function upsertEdit(ops: readonly EditOp[], next: EditOp): EditOp[] {
  const out = ops.filter((op) => op.id !== next.id);
  // A `delete` on something we just `add`ed cancels both — the note
  // never existed in the optimizer output, so removing it is a no-op.
  if (next.kind === "delete") {
    const wasAdded = ops.some((op) => op.id === next.id && op.kind === "add");
    if (wasAdded) return out;
  }
  out.push(next);
  return out;
}
