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

import type { Articulation, BassNote } from "@/audio/midi";
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
  | {
      kind: "replace";
      id: NoteId;
      string: number;
      fret: number;
      /**
       * Optional playing-technique flags. Carried alongside string/fret
       * so toggling an articulation on a note "locks in" its current
       * fingering — the user can re-pick the fret later if they want.
       */
      articulation?: Articulation;
    }
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
      articulation?: Articulation;
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

/**
 * Per-strip mixer state. Stored alongside the other per-song settings
 * so each song remembers its own mute / solo / volume layout across
 * sessions instead of resetting every time the player mounts.
 */
export interface MixerStripState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}

export interface MixerState {
  vocals: MixerStripState;
  drums: MixerStripState;
  bass: MixerStripState;
  other: MixerStripState;
  midi: MixerStripState;
  master: number;
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
  /**
   * Song-time shift applied to every detected beat. Lets the user
   * realign the bar grid when the detector's first beat is early/late.
   * Default 0; can be negative.
   */
  beatsOffsetSec?: number;
  /**
   * Playback-rate multiplier for the beat grid relative to the audio.
   * 1.0 = use the detected beats as-is; >1 squashes them together
   * (bars finish sooner). Applied as: `songT = beatT / beatsSpeed + beatsOffsetSec`.
   */
  beatsSpeed?: number;
  /** Free-form lyrics + chord text, displayed in the side panel. */
  lyrics?: string;
  /**
   * Saved mixer state: per-strip volume + mute + solo flags and a
   * master volume. Missing means the mixer hasn't been touched yet on
   * this song — Player uses its own defaults in that case.
   */
  mixer?: MixerState;
}

/**
 * Default mixer state — stems at full volume, no mute/solo, MIDI a touch
 * lower so a freshly transcribed bass is audible without overwhelming
 * the rest. Used as the seed when an EditsFile has no `mixer` block.
 */
export const DEFAULT_MIXER: MixerState = {
  vocals: { volume: 1, muted: false, soloed: false },
  drums: { volume: 1, muted: false, soloed: false },
  bass: { volume: 1, muted: false, soloed: false },
  other: { volume: 1, muted: false, soloed: false },
  midi: { volume: 0.8, muted: false, soloed: false },
  master: 1,
};

export const EMPTY_EDITS: EditsFile = {
  version: EDITS_VERSION,
  notes: [],
  sections: [],
  cuts: [],
  midiOffsetSec: 0,
  midiSpeed: 1,
  lyrics: "",
};

const STRIP_KEYS = ["vocals", "drums", "bass", "other", "midi"] as const;

function clamp01(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normalizeStrip(raw: unknown, fallback: MixerStripState): MixerStripState {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const r = raw as Partial<MixerStripState>;
  return {
    volume: clamp01(r.volume ?? fallback.volume),
    muted: typeof r.muted === "boolean" ? r.muted : fallback.muted,
    soloed: typeof r.soloed === "boolean" ? r.soloed : fallback.soloed,
  };
}

/**
 * Shape-check a stored mixer block, filling in defaults for missing /
 * out-of-range values. Returns `null` when the input is missing
 * entirely so callers can distinguish "no saved state" from "saved
 * defaults".
 */
export function normalizeMixerState(raw: unknown): MixerState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MixerState>;
  return {
    vocals: normalizeStrip(r.vocals, DEFAULT_MIXER.vocals),
    drums: normalizeStrip(r.drums, DEFAULT_MIXER.drums),
    bass: normalizeStrip(r.bass, DEFAULT_MIXER.bass),
    other: normalizeStrip(r.other, DEFAULT_MIXER.other),
    midi: normalizeStrip(r.midi, DEFAULT_MIXER.midi),
    master: clamp01(r.master ?? DEFAULT_MIXER.master),
  };
}

// Re-exported so consumers can write `mixer.STRIP_KEYS` if they need
// to iterate in a canonical order without redefining the literal.
export const MIXER_STRIP_KEYS = STRIP_KEYS;

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
        ...(op.articulation ? { articulation: op.articulation } : {}),
      });
    }
  }

  const out: TabNote[] = [];
  for (const n of notes) {
    const id = tabNoteId(n);
    if (deleteIds.has(id)) continue;
    const r = replaceById.get(id);
    if (r) {
      const merged: TabNote = { ...n, string: r.string, fret: r.fret };
      if (r.articulation) merged.articulation = r.articulation;
      else if ("articulation" in r) delete merged.articulation;
      out.push(merged);
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
  const articulationById = new Map<NoteId, Articulation | undefined>();
  const additions: BassNote[] = [];
  for (const op of ops) {
    if (op.kind === "delete") deleteIds.add(op.id);
    else if (op.kind === "replace") {
      // String/fret are fingering-only; ignored for synth. We do honour
      // the articulation field so palm-mute / staccato / accent / ghost /
      // harmonic toggles flow into playback.
      articulationById.set(op.id, op.articulation);
    } else if (op.kind === "add") {
      additions.push({
        pitch: op.pitch,
        startSec: op.startSec,
        durSec: op.durSec,
        velocity: op.velocity ?? 1,
        ...(op.articulation ? { articulation: op.articulation } : {}),
      });
    }
  }
  const out: BassNote[] = [];
  for (const n of notes) {
    const id = noteId(n.startSec, n.pitch);
    if (deleteIds.has(id)) continue;
    if (articulationById.has(id)) {
      const art = articulationById.get(id);
      const next: BassNote = { ...n };
      if (art) next.articulation = art;
      else delete next.articulation;
      out.push(next);
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
    const merged = { ...existing, string: next.string, fret: next.fret };
    if (next.articulation) merged.articulation = next.articulation;
    else delete merged.articulation;
    return [...filtered, merged];
  }
  return [...filtered, next];
}
