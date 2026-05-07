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

import type { BassNote } from "@/audio/midi";
import type { TabNote } from "@/tab/optimizer";

export const EDITS_VERSION = 1;

export type NoteId = string;

/**
 * `[startSec, endSec)` audio-time span the user has ripple-deleted from
 * the MIDI. Notes inside the span are dropped; notes after shift back
 * by the span's duration so the next surviving note slides into the
 * deleted slot. The audio recording is untouched. Used to fix an over-
 * transcribed MIDI: extra notes the AI added that the song doesn't
 * contain are deleted, and the rest move forward to stay aligned with
 * the recording.
 */
export interface CutSpan {
  startSec: number;
  endSec: number;
}

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
   * Ripple-delete spans in audio time of the original mapped MIDI.
   * Sorted, non-overlapping. Cuts apply *before* note edits, so edit
   * ids reference the post-cut (shifted) note positions.
   */
  cuts?: CutSpan[];
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
  cuts: [],
  midiOffsetSec: 0,
  midiSpeed: 1,
  lyrics: "",
};

/**
 * Append a cut span. Spans are stored in *sequential* order: each one
 * is interpreted in the time domain that results from applying every
 * earlier cut. That matches the user's mental model (they ripple-
 * delete in whatever view they currently see), and lets the apply
 * function fold left without any merge/overlap math.
 */
export function addCut(cuts: readonly CutSpan[], span: CutSpan): CutSpan[] {
  if (span.endSec <= span.startSec) return cuts.slice();
  return [...cuts, span];
}

/**
 * Remove a cut by index. Note: cuts are sequential, so removing one
 * from the middle changes the time domain that later cuts were
 * defined in. In practice we expect callers to remove only the last
 * cut (i.e., undo); arbitrary mid-list removal may reposition later
 * cut spans relative to the original notes.
 */
export function removeCutAt(cuts: readonly CutSpan[], index: number): CutSpan[] {
  if (index < 0 || index >= cuts.length) return cuts.slice();
  const out = cuts.slice();
  out.splice(index, 1);
  return out;
}

/**
 * Apply the sequential cut list to a note list. For each cut in
 * order: drop notes whose start is inside `[cut.startSec, cut.endSec)`
 * and shift later notes back by the cut's duration. Returns a new
 * list with `startSec` rewritten to match the user's current view —
 * once cuts apply, the shifted time IS the time (no separate "audio
 * time" domain to translate to/from for downstream consumers).
 */
export function applyCutsToNotes<T extends { startSec: number }>(
  notes: readonly T[],
  cuts: readonly CutSpan[],
): T[] {
  if (cuts.length === 0) return notes.slice();
  let result: readonly T[] = notes;
  for (const cut of cuts) {
    const dur = cut.endSec - cut.startSec;
    if (dur <= 0) continue;
    const next: T[] = [];
    for (const n of result) {
      if (n.startSec >= cut.startSec && n.startSec < cut.endSec) continue;
      if (n.startSec >= cut.endSec) {
        next.push({ ...n, startSec: n.startSec - dur });
      } else {
        next.push(n);
      }
    }
    result = next;
  }
  return result === notes ? notes.slice() : (result as T[]);
}

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
 * Apply the playback-affecting subset of note ops (`delete` + `add`) to
 * the bass-synth feed. `replace` is fingering-only and ignored here.
 * Input notes are assumed to already have cuts applied (or no cuts);
 * ids are computed against `n.startSec`, so callers must pass a list
 * in the same time domain the edit ids were produced in.
 */
export function applyNoteEditsToBass(
  notes: readonly BassNote[],
  ops: readonly EditOp[],
): BassNote[] {
  if (ops.length === 0) return notes.slice();
  const deleteIds = new Set<NoteId>();
  const additions: BassNote[] = [];
  for (const op of ops) {
    if (op.kind === "delete") deleteIds.add(op.id);
    else if (op.kind === "add") {
      additions.push({
        pitch: op.pitch,
        startSec: op.startSec,
        durSec: op.durSec,
        velocity: op.velocity ?? 1,
      });
    }
  }
  const out: BassNote[] = [];
  for (const n of notes) {
    if (deleteIds.has(noteId(n.startSec, n.pitch))) continue;
    out.push(n);
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
