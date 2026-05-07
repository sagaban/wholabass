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
  startSec: number;
  endSec: number;
  name: string;
  repeats?: number;
}

export function addSection(sections: readonly SectionLabel[], label: SectionLabel): SectionLabel[] {
  // Sort by startSec so the renderer can iterate in time order without
  // re-sorting on every paint.
  const out = [...sections, label];
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}

export function removeSectionAt(sections: readonly SectionLabel[], index: number): SectionLabel[] {
  if (index < 0 || index >= sections.length) return sections.slice();
  const out = sections.slice();
  out.splice(index, 1);
  return out;
}

/** Patch one field of an existing section without disturbing the order. */
export function updateSectionAt(
  sections: readonly SectionLabel[],
  index: number,
  patch: Partial<SectionLabel>,
): SectionLabel[] {
  if (index < 0 || index >= sections.length) return sections.slice();
  const out = sections.slice();
  out[index] = { ...out[index], ...patch };
  return out;
}

export interface EditsFile {
  version: number;
  notes: EditOp[];
  sections: SectionLabel[];
  /**
   * Song-time shift applied to every MIDI event when loading bass.mid.
   * Lets the user align an uploaded GP / Songsterr export to where the
   * bass actually enters in the audio (their `t = 0` rarely matches).
   * Default 0; can be negative.
   */
  midiOffsetSec?: number;
  /**
   * Playback-rate multiplier for the MIDI relative to the audio. 1.0 =
   * use the file's native timing; >1 speeds it up (notes happen
   * earlier), <1 slows it down. Useful when the uploaded tab was
   * notated at a different BPM than the recording.
   *
   * Applied as: `songT = midiT / midiSpeed + midiOffsetSec`.
   */
  midiSpeed?: number;
  /** Free-form lyrics + chord text, displayed in the side panel. */
  lyrics?: string;
}

export const EMPTY_EDITS: EditsFile = {
  version: EDITS_VERSION,
  notes: [],
  sections: [],
  midiOffsetSec: 0,
  midiSpeed: 1,
  lyrics: "",
};

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
 *
 * Special cases when the existing op is an `add`:
 *  - `delete` cancels both — the note never made it into the optimizer
 *    output, so removing it is a no-op.
 *  - `replace` updates the add's string/fret in place, because a bare
 *    `replace` targets optimizer notes and would silently drop on apply.
 */
export function upsertEdit(ops: readonly EditOp[], next: EditOp): EditOp[] {
  const existing = ops.find((op) => op.id === next.id);
  const filtered = ops.filter((op) => op.id !== next.id);

  if (next.kind === "delete") {
    if (existing?.kind === "add") return filtered;
    return [...filtered, next];
  }
  if (next.kind === "replace" && existing?.kind === "add") {
    return [...filtered, { ...existing, string: next.string, fret: next.fret }];
  }
  return [...filtered, next];
}
