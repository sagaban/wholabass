import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, HStack, styled, VStack } from "styled-system/jsx";
import { css } from "styled-system/css";
import { type StemEngine } from "@/audio/engine";
import { estimateKey } from "@/audio/key";
import { loadBassNotes, pitchName, type Articulation, type BassNote } from "@/audio/midi";
import { SMUFL_REST } from "@/audio/smufl-font";
import { Portal } from "@ark-ui/react/portal";
import { Button, Popover } from "@/components/ui";
import {
  barLineTimes,
  DEFAULT_LAYOUT,
  planSystems,
  rowTimeToX,
  rowXToTime,
  stringIndexToY,
  totalHeight,
  type PlannedSystem,
} from "@/tab/render";
import { DEFAULT_TUNING, enumeratePlacements, fingerNotes, type TabNote } from "@/tab/optimizer";
import {
  beamGroups,
  classifyDuration,
  classifyNote,
  rhythmGlyph,
  type RhythmKind,
} from "@/tab/rhythm";
import {
  applyCutsToNotes,
  applyEdits,
  tabNoteId,
  type CutSpan,
  type EditOp,
  type EditsFile,
  type NoteId,
  type RestEntry,
  type SectionLabel,
} from "@/tab/edits";
import { beatIndexAt, localBeatDuration } from "@/tab/rhythm";

interface TabProps {
  songId: string;
  /**
   * Bumped by the parent when bass.mid is replaced on disk so we
   * reload + re-run the optimizer. Otherwise the load effect would
   * only refire on songId change.
   */
  tabSourceRev: number;
  engine: StemEngine;
  durationSec: number;
  edits: EditsFile;
  onEdit: (op: EditOp) => void;
  /**
   * Wraps a series of `onEdit` calls into a single undo step. Used by
   * drag-commit, multi-delete, paste, and bar-duplicate so a single
   * Cmd+Z reverses the whole gesture.
   */
  transact: (fn: () => void) => void;
  onRemoveSectionAt: (index: number) => void;
  onResizeSectionAt: (index: number, patch: { startSec?: number; endSec?: number }) => void;
  onAddRest: (rest: RestEntry) => void;
  onRemoveRest: (id: string) => void;
  onResizeRest: (id: string, patch: { startSec?: number; durSec?: number }) => void;
  /** Ripple-delete a `[startSec, endSec)` audio-time span. */
  onRippleDelete: (span: CutSpan) => void;
}

interface BeatsPayload {
  tempo_bpm: number;
  beats: number[];
}

type LoadStatus = "loading" | "ready" | { kind: "error"; message: string };

/**
 * Older Songsterr imports stored fingerings authored against the source
 * tab's tuning (5-string with low B, drop-D, etc.) — alphaTab's
 * `realValue` correctly carried the pitch, but the matching
 * `string + fret` only added up under that tuning. The renderer +
 * popover assume `DEFAULT_TUNING` (E-A-D-G), so a note like
 * `string=0, fret=7, pitch=28` read as a broken invariant on screen.
 *
 * Re-pick the placement against standard tuning when the imported one
 * doesn't add up. Notes whose pitch is off the standard fretboard
 * (below E1) are parked at open E so the visual at least renders —
 * the synth still plays their original pitch from the MIDI.
 */
function normaliseTabToStandardTuning(notes: readonly TabNote[]): TabNote[] {
  return notes.map((n) => {
    if (n.pitch === DEFAULT_TUNING[n.string] + n.fret) return n;
    const placements = enumeratePlacements(n.pitch, DEFAULT_TUNING);
    if (placements.length > 0) {
      return { ...n, string: placements[0].string, fret: placements[0].fret };
    }
    return { ...n, string: 0, fret: 0 };
  });
}

export function Tab({
  songId,
  tabSourceRev,
  engine,
  durationSec,
  edits,
  onEdit,
  transact,
  onRemoveSectionAt,
  onResizeSectionAt,
  onAddRest,
  onRemoveRest,
  onResizeRest,
  onRippleDelete,
}: TabProps) {
  const [mappedBass, setMappedBass] = useState<readonly BassNote[]>([]);
  // Explicit-fingering tab from a Songsterr import (or any future GP7
  // import). When present, the loader uses it directly instead of
  // running `fingerNotes` over the MIDI — we know the original tab's
  // string/fret choice, no guessing needed.
  const [explicitTab, setExplicitTab] = useState<readonly TabNote[] | null>(null);
  const [beats, setBeats] = useState<BeatsPayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");

  const midiOffsetSec = edits.midiOffsetSec ?? 0;
  const midiSpeed = edits.midiSpeed && edits.midiSpeed > 0 ? edits.midiSpeed : 1;
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        // Beats are required (the tab grid needs them); bass.mid is
        // optional now — a missing file just yields an empty tab so the
        // user can upload or auto-transcribe from the Tab source card.
        const b = await invoke<BeatsPayload>("read_beats", { songId });
        const raw = await loadBassNotes(songId).catch(() => [] as BassNote[]);
        const rawTab = await invoke<readonly TabNote[] | null>("read_bass_tab", {
          songId,
        }).catch(() => null);
        if (cancelled) return;
        // Older Songsterr imports stored explicit fingerings that
        // assumed the source's non-standard tuning, leaving the
        // `pitch / string / fret` invariant broken under the renderer's
        // standard E-A-D-G. Re-pick the placement here so existing
        // imports work without re-importing.
        const normalisedTab = rawTab ? normaliseTabToStandardTuning(rawTab) : null;
        const shift = <T extends BassNote>(n: T): T => ({
          ...n,
          startSec: n.startSec / midiSpeed + midiOffsetSec,
          durSec: n.durSec / midiSpeed,
        });
        const shifted: BassNote[] =
          midiOffsetSec === 0 && midiSpeed === 1
            ? raw.slice()
            : raw.map((n) =>
                shift({
                  pitch: n.pitch,
                  velocity: n.velocity,
                  startSec: n.startSec,
                  durSec: n.durSec,
                }),
              );
        setMappedBass(shifted);
        // Explicit tab gets the same midi-offset/speed transform so its
        // notes line up with whatever the user is hearing from bass.mid.
        const shiftedTab =
          normalisedTab && (midiOffsetSec !== 0 || midiSpeed !== 1)
            ? normalisedTab.map((n) => shift(n))
            : normalisedTab;
        setExplicitTab(shiftedTab);
        setBeats(b);
        setStatus("ready");
      } catch (err: unknown) {
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId, tabSourceRev, midiOffsetSec, midiSpeed]);

  // Ripple-delete cuts apply *before* fingering — the optimizer sees
  // already-shifted notes so its TabNote ids match the same time
  // domain the synth uses (Player.tsx applies the same `cuts` to its
  // bass feed). Edit ops then layer on top, keyed to those same ids.
  // Memoise so the `?? []` fallback doesn't churn the optimizer on
  // every parent render when no cuts exist.
  const cuts = useMemo(() => edits.cuts ?? [], [edits.cuts]);
  const pitchShift = edits.pitchShiftSemitones ?? 0;
  const fingeredNotes = useMemo(() => {
    if (explicitTab && pitchShift === 0) {
      // Explicit fingering already includes string/fret; cuts still
      // apply (they're audio-time edits).
      return applyCutsToNotes(explicitTab, cuts) as TabNote[];
    }
    // Either no explicit tab OR pitch is transposed: route through the
    // optimizer so the fretboard fingering matches the new pitches.
    // When `pitchShift !== 0` with an explicit tab present we forfeit
    // the human-authored fingering for correctness — flipping pitch
    // back to 0 restores it.
    const baseBass = applyCutsToNotes(mappedBass, cuts) as readonly BassNote[];
    const shifted =
      pitchShift === 0
        ? baseBass
        : baseBass.map(
            (n): BassNote => ({
              pitch: n.pitch + pitchShift,
              startSec: n.startSec,
              durSec: n.durSec,
              velocity: n.velocity,
            }),
          );
    return fingerNotes(shifted);
  }, [explicitTab, mappedBass, cuts, pitchShift]);
  const displayNotes = useMemo(() => applyEdits(fingeredNotes, edits), [fingeredNotes, edits]);

  // Apply the user's beat-grid calibration (offset + speed) to the
  // detected beats. Downstream — bar lines, beam groups, snap-to-16th —
  // just sees the corrected times, so it's a single transformation point.
  const beatsOffsetSec = edits.beatsOffsetSec ?? 0;
  const beatsSpeed = edits.beatsSpeed && edits.beatsSpeed > 0 ? edits.beatsSpeed : 1;
  const adjustedBeats = useMemo<BeatsPayload | null>(() => {
    if (!beats) return null;
    if (beatsOffsetSec === 0 && beatsSpeed === 1) return beats;
    return {
      tempo_bpm: beats.tempo_bpm * beatsSpeed,
      beats: beats.beats.map((t) => t / beatsSpeed + beatsOffsetSec),
    };
  }, [beats, beatsOffsetSec, beatsSpeed]);

  if (status === "loading") {
    return (
      <Box mt="3" opacity="0.7" fontSize="sm">
        loading tab…
      </Box>
    );
  }
  if (typeof status === "object") {
    return (
      <Box mt="3" color="error" fontSize="sm">
        tab load error: {status.message}
      </Box>
    );
  }

  return (
    <TabSurface
      tabNotes={displayNotes}
      beats={adjustedBeats!}
      engine={engine}
      durationSec={durationSec}
      sections={edits.sections}
      rests={edits.rests ?? []}
      onEdit={onEdit}
      transact={transact}
      onRemoveSectionAt={onRemoveSectionAt}
      onResizeSectionAt={onResizeSectionAt}
      onAddRest={onAddRest}
      onRemoveRest={onRemoveRest}
      onResizeRest={onResizeRest}
      onRippleDelete={onRippleDelete}
      playheadOffsetSec={edits.playheadOffsetSec ?? 0}
    />
  );
}

interface TabSurfaceProps {
  tabNotes: TabNote[];
  beats: BeatsPayload;
  engine: StemEngine;
  durationSec: number;
  sections: readonly SectionLabel[];
  rests: readonly RestEntry[];
  onEdit: (op: EditOp) => void;
  transact: (fn: () => void) => void;
  onRemoveSectionAt: (index: number) => void;
  onResizeSectionAt: (index: number, patch: { startSec?: number; endSec?: number }) => void;
  onAddRest: (rest: RestEntry) => void;
  onRemoveRest: (id: string) => void;
  onResizeRest: (id: string, patch: { startSec?: number; durSec?: number }) => void;
  onRippleDelete: (span: CutSpan) => void;
  /** User-tunable visual nudge for the playhead — see EditsFile. */
  playheadOffsetSec: number;
}

interface AddNoteTarget {
  startSec: number;
  string: number;
  /** SVG-coord anchor for the popover. */
  x: number;
  y: number;
}

const STRING_LABELS = ["E", "A", "D", "G"] as const;
const STEM_LENGTH_PX = 14;
const FLAG_LENGTH_PX = 5;
const FLAG_GAP_PX = 3;
const SECTION_BAND_HEIGHT_PX = 16;
const SECTION_HANDLE_W = 6;
const ADD_NOTE_FRETS = Array.from({ length: 13 }, (_, i) => i);

/** Closest tab string index for a y in SVG coordinates. */
function closestString(y: number, layout: typeof DEFAULT_LAYOUT): number {
  let best = 0;
  let bestDist = Infinity;
  for (let s = 0; s < layout.stringCount; s++) {
    const dist = Math.abs(stringIndexToY(s, layout) - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/** Snap a song-time to the nearest 16th-note grid point using the beat track. */
function snapToSixteenth(time: number, beats: readonly number[]): number {
  if (beats.length < 2) return Math.max(0, time);
  const i = beatIndexAt(time, beats);
  const beatStart = beats[i];
  const dur = localBeatDuration(time, beats);
  const sixteenth = dur / 4;
  if (sixteenth <= 0) return Math.max(0, time);
  const offset = time - beatStart;
  const snapped = beatStart + Math.round(offset / sixteenth) * sixteenth;
  return Math.max(0, snapped);
}

function TabSurface({
  tabNotes,
  beats,
  engine,
  durationSec,
  sections,
  rests,
  onEdit,
  transact,
  onRemoveSectionAt,
  onResizeSectionAt,
  onAddRest,
  onRemoveRest,
  onResizeRest,
  onRippleDelete,
  playheadOffsetSec,
}: TabSurfaceProps) {
  const layout = DEFAULT_LAYOUT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const systemElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const playheadRefs = useRef<Map<number, SVGLineElement>>(new Map());
  const activeIdxRef = useRef<number>(-1);

  const height = totalHeight(layout);
  // When the song has any pre-bar-1 intro (the first detected bar
  // doesn't start at t=0), prepend a synthetic boundary at 0 so the
  // intro renders as a proper "bar 0" slot — full bar width, with a
  // bar line and a "0" label — instead of the cramped 24 px gutter.
  // `barNumberOffset` shifts the visible bar numbers down by 1 in
  // that case so the user-detected bars keep their natural numbering
  // (1, 2, 3, …).
  const bars = useMemo(() => {
    const raw = barLineTimes(beats.beats, layout.beatsPerBar);
    return raw.length > 0 && raw[0] > 0 ? [0, ...raw] : raw;
  }, [beats.beats, layout.beatsPerBar]);
  const barNumberOffset = useMemo(() => {
    const raw = barLineTimes(beats.beats, layout.beatsPerBar);
    return raw.length > 0 && raw[0] > 0 ? 0 : 1;
  }, [beats.beats, layout.beatsPerBar]);
  const groups = useMemo(() => beamGroups(tabNotes, beats.beats), [tabNotes, beats.beats]);
  const keyEstimate = useMemo(() => estimateKey(tabNotes), [tabNotes]);

  // Container width drives how many bars fit per row. ResizeObserver
  // keeps it in sync with window resizes / parent layout changes.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const targetRowPx = Math.max(200, containerWidth - 16);
  const systems = useMemo(
    () => planSystems(durationSec, bars, layout, targetRowPx),
    [durationSec, bars, layout, targetRowPx],
  );

  // Pre-slice notes / groups / sections once per (systems, data) change so
  // each row gets only what it needs to render.
  const sliced = useMemo(() => {
    return systems.map((sys) => {
      const sysNotes: TabNote[] = [];
      const noteIndexMap = new Map<number, number>(); // global → local index
      for (let i = 0; i < tabNotes.length; i++) {
        const n = tabNotes[i];
        if (n.startSec >= sys.startSec && n.startSec < sys.endSec) {
          noteIndexMap.set(i, sysNotes.length);
          sysNotes.push(n);
        }
      }
      const sysGroups = groups
        .map((g) => ({
          beamLevels: g.beamLevels,
          indices: g.indices
            .map((gi) => noteIndexMap.get(gi))
            .filter((v): v is number => v !== undefined),
        }))
        .filter((g) => g.indices.length > 0);
      const sysSections = sections
        .map((sec, sectionIdx) => ({ sec, sectionIdx }))
        .filter(({ sec }) => sec.startSec < sys.endSec && sec.endSec > sys.startSec)
        .map(({ sec, sectionIdx }) => ({
          sectionIdx,
          name: sec.name,
          repeats: sec.repeats,
          startSec: Math.max(sec.startSec, sys.startSec),
          endSec: Math.min(sec.endSec, sys.endSec),
          fullSection: sec,
          startsHere: sec.startSec >= sys.startSec,
        }));
      // Explicit rests that intersect this row. Clipped to the row's
      // bounds so a rest spanning two rows renders in both.
      const sysRests = rests.filter(
        (r) => r.startSec < sys.endSec && r.startSec + r.durSec > sys.startSec,
      );
      return { sysNotes, sysGroups, sysSections, sysRests };
    });
  }, [systems, tabNotes, groups, sections, rests]);

  const [selectedId, setSelectedId] = useState<NoteId | null>(null);
  const [selection, setSelection] = useState<Set<NoteId>>(() => new Set());
  const lastClickedRef = useRef<NoteId | null>(null);
  const clipboardRef = useRef<
    {
      pitch: number;
      relStartSec: number;
      durSec: number;
      velocity: number;
      string: number;
      fret: number;
    }[]
  >([]);
  const selectedNote = useMemo(
    () => (selectedId ? (tabNotes.find((n) => tabNoteId(n) === selectedId) ?? null) : null),
    [selectedId, tabNotes],
  );
  const selectedNoteSystemIdx = useMemo(() => {
    if (!selectedNote) return -1;
    return systems.findIndex(
      (sys) => selectedNote.startSec >= sys.startSec && selectedNote.startSec < sys.endSec,
    );
  }, [selectedNote, systems]);
  const closePopover = useCallback(() => setSelectedId(null), []);

  // Range-select all notes whose startSec lies between `a`'s and `b`'s.
  const rangeSelect = useCallback(
    (a: NoteId, b: NoteId) => {
      const aNote = tabNotes.find((n) => tabNoteId(n) === a);
      const bNote = tabNotes.find((n) => tabNoteId(n) === b);
      if (!aNote || !bNote) return;
      const lo = Math.min(aNote.startSec, bNote.startSec);
      const hi = Math.max(aNote.startSec, bNote.startSec);
      const next = new Set<NoteId>();
      for (const n of tabNotes) {
        if (n.startSec >= lo && n.startSec <= hi) next.add(tabNoteId(n));
      }
      setSelection(next);
    },
    [tabNotes],
  );

  const [addTarget, setAddTarget] = useState<(AddNoteTarget & { systemIdx: number }) | null>(null);
  const closeAdd = useCallback(() => setAddTarget(null), []);
  const [selectedSectionIdx, setSelectedSectionIdx] = useState<number | null>(null);
  const closeSection = useCallback(() => setSelectedSectionIdx(null), []);
  const [selectedRestId, setSelectedRestId] = useState<string | null>(null);
  const closeRest = useCallback(() => setSelectedRestId(null), []);

  // Compute the song-time → (system, local x) mapping used by every
  // mouse-driven coord conversion. Memoised on systems only.
  //
  // Systems are contiguous, so the first one whose `endSec` is past
  // `timeSec` is the match. This also clamps correctly at both ends: a
  // time *before* the first system (e.g. seeking to 0 with a negative
  // playhead offset) returns system 0, and a time past the last
  // returns the last system. The old `start <= t < end` form fell
  // through to the last index for below-first times, which jumped the
  // auto-scroll to the bottom of the tab when seeking back to 0.
  const findSystem = useCallback(
    (timeSec: number): number => {
      for (let i = 0; i < systems.length; i++) {
        if (timeSec < systems[i].endSec) return i;
      }
      return systems.length - 1;
    },
    [systems],
  );

  /**
   * Duplicate every note inside `barIdx` into the bar that follows,
   * shifting later notes by one bar duration so the song structure
   * matches an audio repeat that the imported MIDI didn't include.
   * Bar duration is taken from the local beat track; the trailing
   * region after the final bar uses song duration as its right edge.
   */
  const duplicateBar = useCallback(
    (barIdx: number) => {
      if (barIdx < 0 || barIdx >= bars.length) return;
      const barStart = bars[barIdx];
      const barEnd = barIdx + 1 < bars.length ? bars[barIdx + 1] : durationSec;
      const barDur = barEnd - barStart;
      if (barDur <= 0) return;

      const inBar = tabNotes.filter((n) => n.startSec >= barStart && n.startSec < barEnd);
      const after = tabNotes.filter((n) => n.startSec >= barEnd);

      transact(() => {
        // Shift later notes by one bar so the inserted copy fits.
        for (const n of after) {
          onEdit({ kind: "delete", id: tabNoteId(n) });
          onEdit({
            kind: "add",
            id: tabNoteId({ startSec: n.startSec + barDur, pitch: n.pitch }),
            pitch: n.pitch,
            startSec: n.startSec + barDur,
            durSec: n.durSec,
            velocity: n.velocity,
            string: n.string,
            fret: n.fret,
          });
        }
        // Duplicate in-bar notes one bar later.
        for (const n of inBar) {
          const newStart = n.startSec + barDur;
          onEdit({
            kind: "add",
            id: tabNoteId({ startSec: newStart, pitch: n.pitch }),
            pitch: n.pitch,
            startSec: newStart,
            durSec: n.durSec,
            velocity: n.velocity,
            string: n.string,
            fret: n.fret,
          });
        }
      });
    },
    [bars, durationSec, tabNotes, onEdit, transact],
  );

  /** Shift every note at or after `sec` by `delta` seconds. */
  const shiftNotesAfter = useCallback(
    (sec: number, delta: number) => {
      const after = tabNotes.filter((n) => n.startSec >= sec);
      transact(() => {
        for (const n of after) {
          onEdit({ kind: "delete", id: tabNoteId(n) });
          onEdit({
            kind: "add",
            id: tabNoteId({ startSec: n.startSec + delta, pitch: n.pitch }),
            pitch: n.pitch,
            startSec: n.startSec + delta,
            durSec: n.durSec,
            velocity: n.velocity,
            string: n.string,
            fret: n.fret,
          });
        }
      });
    },
    [tabNotes, onEdit, transact],
  );

  // Right-click → context menu state. Captures the click target so menu
  // items can operate at the right bar / time.
  const [ctxMenu, setCtxMenu] = useState<{
    clientX: number;
    clientY: number;
    barIdx: number;
    barStart: number;
    barDur: number;
    pasteSec: number;
  } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const handleStaffContextMenu = useCallback(
    (e: React.MouseEvent<SVGElement>, systemIdx: number) => {
      e.preventDefault();
      const sys = systems[systemIdx];
      if (!sys) return;
      const svg = e.currentTarget as SVGSVGElement;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const local = pt.matrixTransform(ctm.inverse());
      const t = rowXToTime(sys, local.x);
      let barIdx = -1;
      for (let i = 0; i < bars.length; i++) {
        const next = i + 1 < bars.length ? bars[i + 1] : durationSec;
        if (t >= bars[i] && t < next) {
          barIdx = i;
          break;
        }
      }
      if (barIdx < 0) return;
      const barStart = bars[barIdx];
      const barEnd = barIdx + 1 < bars.length ? bars[barIdx + 1] : durationSec;
      setCtxMenu({
        clientX: e.clientX,
        clientY: e.clientY,
        barIdx,
        barStart,
        barDur: barEnd - barStart,
        pasteSec: snapToSixteenth(t, beats.beats),
      });
    },
    [systems, bars, durationSec, beats.beats],
  );

  // Menu actions.
  const ctxCopy = useCallback(() => {
    if (selection.size === 0) return;
    const picked = tabNotes.filter((n) => selection.has(tabNoteId(n)));
    if (picked.length === 0) return;
    const earliest = picked.reduce((m, n) => Math.min(m, n.startSec), Infinity);
    clipboardRef.current = picked.map((n) => ({
      pitch: n.pitch,
      relStartSec: n.startSec - earliest,
      durSec: n.durSec,
      velocity: n.velocity,
      string: n.string,
      fret: n.fret,
    }));
  }, [selection, tabNotes]);

  const ctxCut = useCallback(() => {
    if (selection.size === 0) return;
    ctxCopy();
    transact(() => {
      for (const id of selection) onEdit({ kind: "delete", id });
    });
    setSelection(new Set());
    setSelectedId(null);
  }, [selection, ctxCopy, transact, onEdit]);

  /**
   * Ripple-delete the current selection. The cut span runs from the
   * earliest selected note's onset to the next *surviving* note's
   * onset, so deleting one note (e.g. G in C-E-G-A) hands its slot to
   * the next note (A slides into G's onset). When no surviving note
   * follows, the span ends at the latest selected note's `endSec`.
   */
  /**
   * Move every selected note one string up (toward the higher-pitch
   * string, visually upward in the tab) or down, keeping the pitch
   * fixed by recomputing the fret. Notes that would land on an
   * invalid string (off either end) or off the fretboard (negative
   * fret or past fret 24) are left in place — a chord shape may have
   * some movable voices and some stuck ones; partial moves beat
   * refusing the whole gesture. Whole shift is one undo step.
   */
  const ctxShiftSelectionString = useCallback(
    (direction: -1 | 1) => {
      if (selection.size === 0) return;
      const picked = tabNotes.filter((n) => selection.has(tabNoteId(n)));
      if (picked.length === 0) return;
      transact(() => {
        for (const n of picked) {
          const newString = n.string + direction;
          if (newString < 0 || newString >= DEFAULT_TUNING.length) continue;
          const newFret = n.pitch - DEFAULT_TUNING[newString];
          if (newFret < 0 || newFret > 24) continue;
          onEdit({ kind: "replace", id: tabNoteId(n), string: newString, fret: newFret });
        }
      });
    },
    [selection, tabNotes, transact, onEdit],
  );

  const ctxRippleDelete = useCallback(() => {
    if (selection.size === 0) return;
    const picked = tabNotes
      .filter((n) => selection.has(tabNoteId(n)))
      .toSorted((a, b) => a.startSec - b.startSec);
    if (picked.length === 0) return;
    const first = picked[0];
    const last = picked[picked.length - 1];
    const startSec = first.startSec;
    const successor = tabNotes.find(
      (n) => n.startSec > last.startSec && !selection.has(tabNoteId(n)),
    );
    const endSec = successor ? successor.startSec : last.startSec + Math.max(0, last.durSec);
    if (endSec <= startSec) return;
    transact(() => {
      onRippleDelete({ startSec, endSec });
    });
    setSelection(new Set());
    setSelectedId(null);
  }, [selection, tabNotes, transact, onRippleDelete]);

  const ctxPasteAt = useCallback(
    (sec: number) => {
      if (clipboardRef.current.length === 0) return;
      transact(() => {
        for (const c of clipboardRef.current) {
          const start = sec + c.relStartSec;
          onEdit({
            kind: "add",
            id: tabNoteId({ startSec: start, pitch: c.pitch }),
            pitch: c.pitch,
            startSec: start,
            durSec: c.durSec,
            velocity: c.velocity,
            string: c.string,
            fret: c.fret,
          });
        }
      });
    },
    [transact, onEdit],
  );

  const ctxInsertEmptyBarAfter = useCallback(
    (barIdx: number) => {
      if (barIdx < 0 || barIdx >= bars.length) return;
      const barEnd = barIdx + 1 < bars.length ? bars[barIdx + 1] : durationSec;
      const barDur = barEnd - bars[barIdx];
      if (barDur <= 0) return;
      shiftNotesAfter(barEnd, barDur);
    },
    [bars, durationSec, shiftNotesAfter],
  );

  // Map screen coordinates → drop target on the staff. Used by drag.
  const findDropTarget = useCallback(
    (clientX: number, clientY: number): { startSec: number; string: number } | null => {
      for (const [idx, el] of systemElsRef.current) {
        const rect = el.getBoundingClientRect();
        if (clientY < rect.top || clientY > rect.bottom) continue;
        const sys = systems[idx];
        if (!sys) continue;
        const localX = Math.max(0, Math.min(sys.widthPx, clientX - rect.left));
        const localY = clientY - rect.top;
        const t = rowXToTime(sys, localX);
        const startSec = Math.max(0, Math.min(durationSec, snapToSixteenth(t, beats.beats)));
        const string = closestString(localY, layout);
        return { startSec, string };
      }
      return null;
    },
    [systems, durationSec, beats.beats, layout],
  );

  // Drag state lives in a ref because we update it from window-level
  // mouse listeners — we only need React to know about it on commit so
  // it can dispatch the resulting edit ops.
  const dragRef = useRef<{
    id: NoteId;
    pitch: number;
    durSec: number;
    velocity: number;
    startSec: number;
    string: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  const beginDrag = useCallback(
    (e: React.MouseEvent<SVGElement>, note: TabNote) => {
      // Only respond to left-click; right-click handled separately.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const id = tabNoteId(note);
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      dragRef.current = {
        id,
        pitch: note.pitch,
        durSec: note.durSec,
        velocity: note.velocity,
        startSec: note.startSec,
        string: note.string,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (dx * dx + dy * dy > 9) drag.moved = true;
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;

        // No movement: act on selection. Modifiers gate which mode.
        if (!drag.moved) {
          if (meta) {
            // Toggle this note in the multi-select set.
            setSelection((prev) => {
              const next = new Set(prev);
              if (next.has(drag.id)) next.delete(drag.id);
              else next.add(drag.id);
              return next;
            });
            lastClickedRef.current = drag.id;
            setSelectedId(null);
          } else if (shift && lastClickedRef.current) {
            rangeSelect(lastClickedRef.current, drag.id);
            setSelectedId(null);
          } else {
            // Plain click → single-select + open popover.
            setSelection(new Set([drag.id]));
            lastClickedRef.current = drag.id;
            setSelectedId(drag.id);
          }
          return;
        }

        const target = findDropTarget(ev.clientX, ev.clientY);
        if (!target) return;
        const dSec = target.startSec - drag.startSec;
        const dString = target.string - drag.string;
        if (Math.abs(dSec) < 1e-6 && dString === 0) return;

        // Group drag: if the dragged note is part of the current
        // multi-selection, move the whole selection by the same delta;
        // otherwise drag only this note. We snapshot the selected
        // TabNotes upfront so the loop sees consistent input.
        const groupNotes =
          selection.has(drag.id) && selection.size > 1
            ? tabNotes.filter((n) => selection.has(tabNoteId(n)))
            : [
                {
                  pitch: drag.pitch,
                  startSec: drag.startSec,
                  durSec: drag.durSec,
                  velocity: drag.velocity,
                  string: drag.string,
                  fret: drag.pitch - DEFAULT_TUNING[drag.string],
                } as TabNote,
              ];

        transact(() => {
          for (const n of groupNotes) {
            const newString = Math.max(0, Math.min(DEFAULT_TUNING.length - 1, n.string + dString));
            const newFret = n.pitch - DEFAULT_TUNING[newString];
            if (newFret < 0 || newFret > 24) continue;
            const newStartSec = Math.max(0, n.startSec + dSec);
            const oldId = tabNoteId(n);
            const startChanged = Math.abs(dSec) > 1e-6;
            if (startChanged) {
              onEdit({ kind: "delete", id: oldId });
              onEdit({
                kind: "add",
                id: tabNoteId({ startSec: newStartSec, pitch: n.pitch }),
                pitch: n.pitch,
                startSec: newStartSec,
                durSec: n.durSec,
                velocity: n.velocity,
                string: newString,
                fret: newFret,
              });
            } else {
              onEdit({ kind: "replace", id: oldId, string: newString, fret: newFret });
            }
          }
        });
        // Selection ids may be stale (startSec changed) — clear so the
        // user makes a fresh selection on the new positions.
        setSelection(new Set());
        lastClickedRef.current = null;
        setSelectedId(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [findDropTarget, onEdit, rangeSelect, selection, tabNotes, transact],
  );

  const openAddNoteAt = useCallback(
    (localX: number, localY: number, systemIdx: number) => {
      if (localY < layout.topPadding - 6) return;
      const sys = systems[systemIdx];
      if (!sys) return;
      const stringIdx = closestString(localY, layout);
      const localTime = rowXToTime(sys, localX);
      const startSec = snapToSixteenth(localTime, beats.beats);
      if (startSec >= durationSec) return;
      const targetSystemIdx = findSystem(startSec);
      const targetSys = systems[targetSystemIdx];
      if (!targetSys) return;
      setAddTarget({
        systemIdx: targetSystemIdx,
        startSec,
        string: stringIdx,
        x: rowTimeToX(targetSys, startSec),
        y: stringIndexToY(stringIdx, layout),
      });
    },
    [systems, beats.beats, layout, durationSec, findSystem],
  );

  // Marquee: drag a rect on empty staff to lasso notes inside.
  const [marquee, setMarquee] = useState<{
    systemIdx: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);

  const beginStaffMouseDown = useCallback(
    (e: React.MouseEvent<SVGElement>, systemIdx: number) => {
      if (e.button !== 0) return;
      // Click events on note <g>s already stopPropagation, so we only
      // get here when the user grabs empty staff.
      const svg = e.currentTarget as SVGSVGElement;
      const ctm0 = svg.getScreenCTM();
      if (!ctm0) return;
      const startPt = svg.createSVGPoint();
      startPt.x = e.clientX;
      startPt.y = e.clientY;
      const start = startPt.matrixTransform(ctm0.inverse());
      const downX = e.clientX;
      const downY = e.clientY;
      let moved = false;

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - downX;
        const dy = ev.clientY - downY;
        if (dx * dx + dy * dy > 9) moved = true;
        if (!moved) return;
        const ctm = svg.getScreenCTM();
        if (!ctm) return;
        const cur = svg.createSVGPoint();
        cur.x = ev.clientX;
        cur.y = ev.clientY;
        const local = cur.matrixTransform(ctm.inverse());
        setMarquee({
          systemIdx,
          x1: start.x,
          y1: start.y,
          x2: local.x,
          y2: local.y,
        });
      };
      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!moved) {
          openAddNoteAt(start.x, start.y, systemIdx);
          return;
        }
        // Finalise: select notes inside the rect.
        const ctm = svg.getScreenCTM();
        const endPt = svg.createSVGPoint();
        endPt.x = ev.clientX;
        endPt.y = ev.clientY;
        const end = ctm ? endPt.matrixTransform(ctm.inverse()) : start;
        const xLo = Math.min(start.x, end.x);
        const xHi = Math.max(start.x, end.x);
        const yLo = Math.min(start.y, end.y);
        const yHi = Math.max(start.y, end.y);
        const sys = systems[systemIdx];
        const next = new Set<NoteId>();
        if (sys) {
          for (const n of tabNotes) {
            if (n.startSec < sys.startSec || n.startSec >= sys.endSec) continue;
            const x = rowTimeToX(sys, n.startSec);
            const y = stringIndexToY(n.string, layout);
            if (x >= xLo && x <= xHi && y >= yLo && y <= yHi) {
              next.add(tabNoteId(n));
            }
          }
        }
        setSelection(next);
        setSelectedId(null);
        lastClickedRef.current = null;
        setMarquee(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [openAddNoteAt, systems, tabNotes, layout],
  );

  // Window-level keyboard shortcuts for the multi-select clipboard.
  // We skip when an input/textarea has focus so typing in a section
  // dialog or repeats field doesn't trigger Esc / Backspace handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        setSelection(new Set());
        setSelectedId(null);
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selection.size > 0) {
        // Shift = ripple delete (also closes the gap so later notes
        // slide back). Plain delete just removes the notes, leaving
        // their slots silent.
        if (e.shiftKey) {
          ctxRippleDelete();
        } else {
          transact(() => {
            for (const id of selection) onEdit({ kind: "delete", id });
          });
          setSelection(new Set());
          setSelectedId(null);
        }
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === "c" && selection.size > 0) {
        const picked = tabNotes.filter((n) => selection.has(tabNoteId(n)));
        if (picked.length === 0) return;
        const earliest = picked.reduce((m, n) => Math.min(m, n.startSec), Infinity);
        clipboardRef.current = picked.map((n) => ({
          pitch: n.pitch,
          relStartSec: n.startSec - earliest,
          durSec: n.durSec,
          velocity: n.velocity,
          string: n.string,
          fret: n.fret,
        }));
        e.preventDefault();
        return;
      }
      if (meta && e.key.toLowerCase() === "v" && clipboardRef.current.length > 0) {
        const t0 = engine.getCurrentTime();
        transact(() => {
          for (const c of clipboardRef.current) {
            const start = t0 + c.relStartSec;
            onEdit({
              kind: "add",
              id: tabNoteId({ startSec: start, pitch: c.pitch }),
              pitch: c.pitch,
              startSec: start,
              durSec: c.durSec,
              velocity: c.velocity,
              string: c.string,
              fret: c.fret,
            });
          }
        });
        e.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, tabNotes, onEdit, engine, transact, ctxRippleDelete]);

  // rAF: place playhead in the active system, scroll that row into view
  // when it changes (or when the user is mid-playback and seeks).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // User-tunable visual offset so the playhead can be nudged into
      // sync with whatever audio path the listener's on (built-in vs
      // bluetooth latency, etc). Synth scheduling stays untouched.
      const t = engine.getCurrentTime() + playheadOffsetSec;
      const idx = findSystem(t);
      const sys = systems[idx];
      if (sys) {
        const localX = rowTimeToX(sys, t);
        const ph = playheadRefs.current.get(idx);
        if (ph) {
          ph.setAttribute("x1", String(localX));
          ph.setAttribute("x2", String(localX));
        }
        // Hide playheads on other rows.
        if (idx !== activeIdxRef.current) {
          const oldPh = playheadRefs.current.get(activeIdxRef.current);
          if (oldPh) {
            oldPh.setAttribute("x1", "-10");
            oldPh.setAttribute("x2", "-10");
          }
          activeIdxRef.current = idx;
          // Auto-scroll to keep the active row visible plus a row of
          // look-ahead below it. We compute the scroll delta by hand
          // (rather than scrollIntoView) so the active row is never
          // pushed off the top: scrolling the look-ahead row into view
          // with `block: "nearest"` would anchor it to the top edge
          // when it sits above the viewport, hiding the playhead row.
          const container = scrollRef.current;
          const rowEl = systemElsRef.current.get(idx);
          if (container && rowEl) {
            const lookEl = systemElsRef.current.get(idx + 1) ?? rowEl;
            const c = container.getBoundingClientRect();
            const row = rowEl.getBoundingClientRect();
            const look = lookEl.getBoundingClientRect();
            if (row.top < c.top) {
              // Active row above the viewport — bring its top into view.
              container.scrollBy({ top: row.top - c.top, behavior: "smooth" });
            } else if (look.bottom > c.bottom) {
              // Active row's look-ahead extends past the bottom — scroll
              // just enough to reveal it, keeping the active row above.
              container.scrollBy({ top: look.bottom - c.bottom, behavior: "smooth" });
            }
          }
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, layout, systems, findSystem, playheadOffsetSec]);

  return (
    <Box mt="3">
      <Box as="div" fontSize="xs" opacity="0.85" mb="1" fontVariantNumeric="tabular-nums">
        ♩ ={" "}
        <styled.span color="tomato.11" fontWeight="semibold">
          {Math.round(beats.tempo_bpm)}
        </styled.span>{" "}
        · {bars.length} bars · {tabNotes.length} notes
        {keyEstimate && (
          <>
            {" · key "}
            <styled.span color="tomato.11" fontWeight="semibold">
              {keyEstimate.tonic} {keyEstimate.mode}
            </styled.span>
          </>
        )}
      </Box>
      <Box
        ref={scrollRef}
        position="relative"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        overflowX="hidden"
        overflowY="auto"
        bg="canvas"
        maxHeight="calc(100vh - 240px)"
        display="flex"
        flexDirection="column"
        gap="1"
        p="2"
        userSelect="none"
        data-print-expand
      >
        {systems.map((sys, idx) => {
          const sectionForThisRow =
            selectedSectionIdx !== null
              ? sliced[idx].sysSections.find((s) => s.sectionIdx === selectedSectionIdx)
              : undefined;
          return (
            <TabSystemRow
              key={`sys-${sys.startSec.toFixed(3)}-${sys.endSec.toFixed(3)}`}
              system={sys}
              layout={layout}
              heightPx={height}
              beats={beats}
              bars={bars}
              barNumberOffset={barNumberOffset}
              notes={sliced[idx].sysNotes}
              groups={sliced[idx].sysGroups}
              sections={sliced[idx].sysSections}
              explicitRests={sliced[idx].sysRests}
              selectedRestId={selectedRestId}
              onPickRest={setSelectedRestId}
              onCloseRest={closeRest}
              onMaterialiseRest={(startSec, durSec) => {
                // Create the entity and immediately select it so the
                // user can resize / delete via the popover.
                const id = crypto.randomUUID();
                onAddRest({ id, startSec, durSec });
                setSelectedRestId(id);
              }}
              onRemoveRest={onRemoveRest}
              onResizeRest={onResizeRest}
              selectedNote={selectedNoteSystemIdx === idx ? selectedNote : null}
              selection={selection}
              selectedSection={
                sectionForThisRow && sectionForThisRow.startsHere
                  ? sectionForThisRow.fullSection
                  : null
              }
              selectedSectionIdx={selectedSectionIdx}
              addTarget={addTarget && addTarget.systemIdx === idx ? addTarget : null}
              onEdit={onEdit}
              onClosePopover={closePopover}
              onCloseAdd={closeAdd}
              onCloseSection={closeSection}
              onAddNote={(string, fret) => {
                if (!addTarget) return;
                const pitch = DEFAULT_TUNING[string] + fret;
                const id = tabNoteId({ startSec: addTarget.startSec, pitch });
                onEdit({
                  kind: "add",
                  id,
                  pitch,
                  startSec: addTarget.startSec,
                  durSec: localBeatDuration(addTarget.startSec, beats.beats),
                  velocity: 1,
                  string,
                  fret,
                });
                closeAdd();
              }}
              onDeleteSection={() => {
                if (selectedSectionIdx === null) return;
                onRemoveSectionAt(selectedSectionIdx);
                closeSection();
              }}
              onResizeSection={(patch) => {
                if (selectedSectionIdx === null) return;
                onResizeSectionAt(selectedSectionIdx, patch);
              }}
              durationSec={durationSec}
              onNoteMouseDown={beginDrag}
              onPickSection={setSelectedSectionIdx}
              onStaffMouseDown={(e) => beginStaffMouseDown(e, idx)}
              onContextStaff={(e) => handleStaffContextMenu(e, idx)}
              marquee={marquee && marquee.systemIdx === idx ? marquee : null}
              registerSystemEl={(el) => {
                if (el) systemElsRef.current.set(idx, el);
                else systemElsRef.current.delete(idx);
              }}
              registerPlayhead={(el) => {
                if (el) playheadRefs.current.set(idx, el);
                else playheadRefs.current.delete(idx);
              }}
            />
          );
        })}
      </Box>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.clientX}
          y={ctxMenu.clientY}
          canCopy={selection.size > 0}
          canPaste={clipboardRef.current.length > 0}
          canRippleDelete={selection.size > 0}
          canShiftStrings={selection.size > 0}
          onCopy={() => {
            ctxCopy();
            closeCtxMenu();
          }}
          onCut={() => {
            ctxCut();
            closeCtxMenu();
          }}
          onRippleDelete={() => {
            ctxRippleDelete();
            closeCtxMenu();
          }}
          onShiftStringUp={() => {
            ctxShiftSelectionString(1);
            closeCtxMenu();
          }}
          onShiftStringDown={() => {
            ctxShiftSelectionString(-1);
            closeCtxMenu();
          }}
          onPaste={() => {
            ctxPasteAt(ctxMenu.pasteSec);
            closeCtxMenu();
          }}
          onInsertEmptyBar={() => {
            ctxInsertEmptyBarAfter(ctxMenu.barIdx);
            closeCtxMenu();
          }}
          onDuplicateBar={() => {
            duplicateBar(ctxMenu.barIdx);
            closeCtxMenu();
          }}
          onClose={closeCtxMenu}
        />
      )}
    </Box>
  );
}

interface ContextMenuProps {
  x: number;
  y: number;
  canCopy: boolean;
  canPaste: boolean;
  canRippleDelete: boolean;
  canShiftStrings: boolean;
  onCopy: () => void;
  onCut: () => void;
  onRippleDelete: () => void;
  onShiftStringUp: () => void;
  onShiftStringDown: () => void;
  onPaste: () => void;
  onInsertEmptyBar: () => void;
  onDuplicateBar: () => void;
  onClose: () => void;
}

function ContextMenu({
  x,
  y,
  canCopy,
  canPaste,
  canRippleDelete,
  canShiftStrings,
  onCopy,
  onCut,
  onRippleDelete,
  onShiftStringUp,
  onShiftStringDown,
  onPaste,
  onInsertEmptyBar,
  onDuplicateBar,
  onClose,
}: ContextMenuProps) {
  // A backdrop catches clicks anywhere outside the menu and closes
  // it. Esc also closes; we attach the keydown lazily so it doesn't
  // fight the multi-select shortcuts when no menu is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items: { label: string; disabled?: boolean; run: () => void }[] = [
    { label: "Copy", disabled: !canCopy, run: onCopy },
    { label: "Cut", disabled: !canCopy, run: onCut },
    {
      label: "Ripple delete (close gap)",
      disabled: !canRippleDelete,
      run: onRippleDelete,
    },
    {
      label: "Move up a string (same pitch)",
      disabled: !canShiftStrings,
      run: onShiftStringUp,
    },
    {
      label: "Move down a string (same pitch)",
      disabled: !canShiftStrings,
      run: onShiftStringDown,
    },
    { label: "Paste here", disabled: !canPaste, run: onPaste },
    { label: "Insert empty bar after this", run: onInsertEmptyBar },
    { label: "Duplicate this bar", run: onDuplicateBar },
  ];

  return (
    <Box
      position="fixed"
      inset="0"
      zIndex="100"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <Box
        position="absolute"
        backdropFilter="blur(12px)"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l1"
        boxShadow="lg"
        py="1"
        minWidth="200px"
        style={{
          left: `${x}px`,
          top: `${y}px`,
          // Solid-ish dark backing so the staff underneath doesn't bleed
          // through; the backdropFilter above adds a frosted-glass blur.
          backgroundColor: "rgba(15, 15, 22, 0.88)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <styled.button
            key={it.label}
            type="button"
            onClick={() => {
              if (it.disabled) return;
              it.run();
            }}
            disabled={it.disabled}
            display="block"
            width="100%"
            textAlign="left"
            px="3"
            py="1.5"
            fontSize="sm"
            bg="transparent"
            border="none"
            cursor={it.disabled ? "not-allowed" : "pointer"}
            opacity={it.disabled ? "0.4" : "1"}
            _hover={it.disabled ? undefined : { bg: "bg.muted" }}
          >
            {it.label}
          </styled.button>
        ))}
      </Box>
    </Box>
  );
}

interface TabSystemRowProps {
  system: PlannedSystem;
  layout: typeof DEFAULT_LAYOUT;
  heightPx: number;
  beats: BeatsPayload;
  /**
   * Bar-line times. May start with a synthetic 0 if the song has an
   * intro before the first detected beat — in that case `barNumberOffset`
   * is 0 so the prepended boundary renders as bar 0 and the real bars
   * keep their natural numbering.
   */
  bars: readonly number[];
  barNumberOffset: number;
  notes: TabNote[];
  groups: { indices: number[]; beamLevels: number }[];
  sections: {
    sectionIdx: number;
    name: string;
    repeats?: number;
    startSec: number;
    endSec: number;
    fullSection: SectionLabel;
    startsHere: boolean;
  }[];
  /** Explicit rests intersecting this row. */
  explicitRests: readonly RestEntry[];
  selectedRestId: string | null;
  onPickRest: (id: string) => void;
  onCloseRest: () => void;
  /**
   * Materialise a rest entity. Called from the AddNote popover's "Add
   * rest" button AND from clicks on inferred ghost rests (which promote
   * themselves to explicit rests when grabbed).
   */
  onMaterialiseRest: (startSec: number, durSec: number) => void;
  onRemoveRest: (id: string) => void;
  onResizeRest: (id: string, patch: { startSec?: number; durSec?: number }) => void;
  selectedNote: TabNote | null;
  selection: ReadonlySet<NoteId>;
  selectedSection: SectionLabel | null;
  selectedSectionIdx: number | null;
  addTarget: AddNoteTarget | null;
  onEdit: (op: EditOp) => void;
  onClosePopover: () => void;
  onCloseAdd: () => void;
  onCloseSection: () => void;
  onAddNote: (string: number, fret: number) => void;
  onDeleteSection: () => void;
  onResizeSection: (patch: { startSec?: number; endSec?: number }) => void;
  durationSec: number;
  onNoteMouseDown: (e: React.MouseEvent<SVGElement>, note: TabNote) => void;
  onPickSection: (idx: number) => void;
  onStaffMouseDown: (e: React.MouseEvent<SVGElement>) => void;
  onContextStaff: (e: React.MouseEvent<SVGElement>) => void;
  marquee: { x1: number; y1: number; x2: number; y2: number } | null;
  registerSystemEl: (el: HTMLDivElement | null) => void;
  registerPlayhead: (el: SVGLineElement | null) => void;
}

function TabSystemRow({
  system,
  layout,
  heightPx,
  beats,
  bars,
  barNumberOffset,
  notes,
  groups,
  sections,
  explicitRests,
  selectedRestId,
  onPickRest,
  onCloseRest,
  onMaterialiseRest,
  onRemoveRest,
  onResizeRest,
  selectedNote,
  selection,
  selectedSection,
  selectedSectionIdx,
  addTarget,
  onEdit,
  onClosePopover,
  onCloseAdd,
  onCloseSection,
  onAddNote,
  onDeleteSection,
  onResizeSection,
  durationSec,
  onNoteMouseDown,
  onPickSection,
  onStaffMouseDown,
  onContextStaff,
  marquee,
  registerSystemEl,
  registerPlayhead,
}: TabSystemRowProps) {
  // Per-bar info for this row: position, bar number, and the root
  // note label derived from the first bass note that lands on the
  // bar's downbeat. The downbeat window is the first quarter of the
  // bar so a bass slide later in the bar doesn't override the root.
  const localBars = useMemo(() => {
    const out: { localX: number; barNumber: number; rootLabel: string | null }[] = [];
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i];
      if (t < system.startSec || t >= system.endSec) continue;
      const end = i + 1 < bars.length ? bars[i + 1] : system.endSec;
      const downbeatWindow = t + (end - t) * 0.25;
      let rootPitch: number | null = null;
      for (const n of notes) {
        if (n.startSec >= downbeatWindow) break;
        if (n.startSec >= t && (rootPitch === null || n.pitch < rootPitch)) {
          rootPitch = n.pitch;
        }
      }
      const rootLabel = rootPitch === null ? null : pitchName(rootPitch).replace(/-?\d+$/, "");
      out.push({
        localX: rowTimeToX(system, t),
        barNumber: i + barNumberOffset,
        rootLabel,
      });
    }
    return out;
  }, [bars, barNumberOffset, system, notes]);

  // Rests = gaps between consecutive notes inside this row, plus a
  // leading gap before the first note and a trailing gap after the last.
  // Anything shorter than a 32nd note is ignored — that's just the
  // floating-point space between chained sub-divisions, not a musical
  // rest.
  const rests = useMemo(() => {
    const out: { startSec: number; durSec: number; kind: RhythmKind }[] = [];
    let cursor = system.startSec;
    const flush = (gapStart: number, gapEnd: number) => {
      const dur = gapEnd - gapStart;
      if (dur <= 0) return;
      const beatSec = localBeatDuration(gapStart, beats.beats);
      if (dur < beatSec / 4 - 1e-6) return; // < 16th note → ignore
      out.push({
        startSec: gapStart,
        durSec: dur,
        kind: classifyDuration(dur, beatSec),
      });
    };
    for (const n of notes) {
      if (n.startSec > cursor) flush(cursor, n.startSec);
      cursor = Math.max(cursor, n.startSec + n.durSec);
    }
    if (cursor < system.endSec) flush(cursor, system.endSec);
    return out;
  }, [system, notes, beats.beats]);

  const stemTop = stringIndexToY(0, layout) + 2;
  const stemBottom = stringIndexToY(0, layout) + STEM_LENGTH_PX;

  return (
    <Box
      ref={registerSystemEl}
      position="relative"
      width={`${system.widthPx}px`}
      flexShrink="0"
      data-print-row
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events */}
      <svg
        width={system.widthPx}
        height={heightPx}
        role="application"
        aria-label="bass tab editor row"
        onMouseDown={onStaffMouseDown}
        onContextMenu={onContextStaff}
        className={css({ display: "block", fontFamily: "inherit" })}
      >
        {/* Section bands clipped to this row */}
        {sections.map((s) => {
          const x1 = rowTimeToX(system, s.startSec);
          const x2 = rowTimeToX(system, s.endSec);
          const isSelected = selectedSectionIdx === s.sectionIdx;
          const showLabel = s.startsHere;
          const labelText = s.repeats && s.repeats > 1 ? `${s.name} ×${s.repeats}` : s.name;
          // Drag handles render only on the row that owns each edge —
          // cross-row resize goes through the numeric inputs in the popover.
          const startsHere = s.startsHere;
          const endsHere = s.fullSection.endSec <= system.endSec;
          const beginResize =
            (edge: "start" | "end") => (ev: React.PointerEvent<SVGRectElement>) => {
              ev.stopPropagation();
              ev.preventDefault();
              const handle = ev.currentTarget;
              const svg = handle.ownerSVGElement;
              if (!svg) return;
              handle.setPointerCapture(ev.pointerId);
              const MIN_GAP = 0.01;
              const anchorStart = s.fullSection.startSec;
              const anchorEnd = s.fullSection.endSec;
              const onMove = (e: PointerEvent) => {
                const rect = svg.getBoundingClientRect();
                const localX = e.clientX - rect.left;
                const rawT = rowXToTime(system, localX);
                if (edge === "start") {
                  const next = Math.max(0, Math.min(rawT, anchorEnd - MIN_GAP));
                  onResizeSection({ startSec: next });
                } else {
                  const max = durationSec > 0 ? durationSec : rawT;
                  const next = Math.max(anchorStart + MIN_GAP, Math.min(rawT, max));
                  onResizeSection({ endSec: next });
                }
              };
              const onUp = (e: PointerEvent) => {
                handle.releasePointerCapture(e.pointerId);
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onUp);
                handle.removeEventListener("pointercancel", onUp);
              };
              handle.addEventListener("pointermove", onMove);
              handle.addEventListener("pointerup", onUp);
              handle.addEventListener("pointercancel", onUp);
            };
          return (
            <g key={`sec-${s.sectionIdx}`}>
              <rect
                x={x1}
                y={2}
                width={Math.max(2, x2 - x1)}
                height={SECTION_BAND_HEIGHT_PX}
                rx={2}
                fill={isSelected ? "var(--colors-indigo-4)" : "var(--colors-indigo-3)"}
                stroke="var(--colors-indigo-7)"
                strokeWidth={1}
                onClick={(ev) => {
                  ev.stopPropagation();
                  ev.preventDefault();
                  onPickSection(s.sectionIdx);
                }}
                className={css({ cursor: "pointer" })}
              />
              {showLabel && (
                <text
                  x={x1 + 5}
                  y={SECTION_BAND_HEIGHT_PX - 3}
                  fontSize="11"
                  fontWeight="600"
                  fill="var(--colors-indigo-11)"
                  pointerEvents="none"
                >
                  {labelText}
                </text>
              )}
              {isSelected && startsHere && (
                <rect
                  x={x1 - SECTION_HANDLE_W / 2}
                  y={2}
                  width={SECTION_HANDLE_W}
                  height={SECTION_BAND_HEIGHT_PX}
                  rx={1}
                  fill="var(--colors-indigo-9)"
                  className={css({ cursor: "ew-resize" })}
                  onPointerDown={beginResize("start")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                  }}
                  data-section-handle=""
                  aria-label="drag to change section start"
                />
              )}
              {isSelected && endsHere && (
                <rect
                  x={x2 - SECTION_HANDLE_W / 2}
                  y={2}
                  width={SECTION_HANDLE_W}
                  height={SECTION_BAND_HEIGHT_PX}
                  rx={1}
                  fill="var(--colors-indigo-9)"
                  className={css({ cursor: "ew-resize" })}
                  onPointerDown={beginResize("end")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                  }}
                  data-section-handle=""
                  aria-label="drag to change section end"
                />
              )}
            </g>
          );
        })}

        {/* String lines */}
        {STRING_LABELS.map((label, i) => {
          const y = stringIndexToY(i, layout);
          return (
            <line
              key={`str-${label}`}
              x1={0}
              x2={system.widthPx}
              y1={y}
              y2={y}
              stroke="var(--colors-border)"
              strokeWidth={1}
            />
          );
        })}

        {/* String labels in the left margin */}
        {STRING_LABELS.map((label, i) => (
          <text
            key={`label-${label}`}
            x={4}
            y={stringIndexToY(i, layout) + 4}
            fontSize="11"
            fill="var(--colors-fg-muted)"
          >
            {label}
          </text>
        ))}

        {/* Beat + 8th-note subdivision grid. Drawn before bar lines so
            the darker bar strokes paint on top. Beats inside [system] are
            full strokes; 8th-note midpoints are dashed and very faint. */}
        {beats.beats.map((t) => {
          if (t < system.startSec || t >= system.endSec) return null;
          // Bar boundaries get their own (darker) stroke below.
          if (bars.some((b) => Math.abs(b - t) < 1e-4)) return null;
          const x = rowTimeToX(system, t);
          return (
            <line
              key={`beat-${t.toFixed(4)}`}
              x1={x}
              x2={x}
              y1={layout.topPadding - 2}
              y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing + 2}
              stroke="var(--colors-border)"
              strokeWidth={0.5}
              opacity={0.6}
              pointerEvents="none"
            />
          );
        })}
        {beats.beats.map((t, i) => {
          const next = beats.beats[i + 1];
          if (next === undefined) return null;
          const mid = (t + next) / 2;
          if (mid < system.startSec || mid >= system.endSec) return null;
          const x = rowTimeToX(system, mid);
          return (
            <line
              key={`8th-${mid.toFixed(4)}`}
              x1={x}
              x2={x}
              y1={layout.topPadding + 2}
              y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing - 2}
              stroke="var(--colors-border)"
              strokeWidth={0.5}
              opacity={0.3}
              strokeDasharray="2 2"
              pointerEvents="none"
            />
          );
        })}

        {/* Bar lines + chord-root labels + bar numbers */}
        {localBars.map((b) => (
          <g key={`bar-${b.barNumber}`}>
            <line
              x1={b.localX}
              x2={b.localX}
              y1={layout.topPadding - 4}
              y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing + 4}
              stroke="var(--colors-border)"
              strokeWidth={b.barNumber === 1 ? 2 : 1}
            />
            {b.rootLabel && (
              <text
                x={b.localX + 3}
                y={layout.topPadding - 22}
                fontSize="13"
                fontWeight="600"
                fill="var(--colors-tomato-11)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {b.rootLabel}
              </text>
            )}
            <text
              x={b.localX + 3}
              y={layout.topPadding - 8}
              fontSize="10"
              fill="var(--colors-fg-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {b.barNumber}
            </text>
          </g>
        ))}

        {/* Fret numbers — click to edit */}
        {notes.map((n, i) => {
          const x = rowTimeToX(system, n.startSec);
          const y = stringIndexToY(n.string, layout);
          const glyph = rhythmGlyph(classifyNote(n, beats.beats));
          const id = tabNoteId(n);
          const isPopoverTarget = selectedNote ? id === tabNoteId(selectedNote) : false;
          const isInSelection = selection.has(id);
          const isSelected = isPopoverTarget || isInSelection;
          // Slide / legato connectors only draw when the next note also
          // lives in this row — cross-row glides are too rare to chase.
          const nextInRow = notes[i + 1];
          const nextX = nextInRow ? rowTimeToX(system, nextInRow.startSec) : null;
          const nextY = nextInRow ? stringIndexToY(nextInRow.string, layout) : null;
          return (
            <g
              key={id}
              onMouseDown={(ev) => onNoteMouseDown(ev, n)}
              className={css({ cursor: "grab" })}
            >
              {/* Invisible hit target — generous so clicks slightly off
                  the fret number still grab the note for drag/select.
                  fill is "transparent" (still painted, so SVG hit-tests
                  it under the default visiblePainted rule). */}
              <rect
                x={x - 11}
                y={y - 10}
                width={22}
                height={20}
                fill="transparent"
                style={{ pointerEvents: "all" }}
              />
              <rect
                x={x - 7}
                y={y - 8}
                width={14}
                height={16}
                rx={3}
                fill={isSelected ? "var(--colors-tomato-9)" : "var(--colors-canvas)"}
                stroke={isSelected ? "var(--colors-tomato-11)" : "none"}
                strokeWidth={isSelected ? 1 : 0}
              />
              <text
                x={x}
                y={y + 4}
                fontSize="12"
                textAnchor="middle"
                fontWeight="600"
                fill={isSelected ? "var(--colors-tomato-1)" : "var(--colors-indigo-11)"}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {n.articulation?.ghost ? `(${n.fret})` : n.fret}
              </text>
              {n.articulation?.accent && (
                <text
                  x={x}
                  y={y - 10}
                  fontSize="11"
                  textAnchor="middle"
                  fontWeight="600"
                  fill="var(--colors-tomato-11)"
                >
                  {">"}
                </text>
              )}
              {n.articulation?.staccato && (
                <circle cx={x} cy={y - 12} r={1.6} fill="var(--colors-indigo-11)" />
              )}
              {n.articulation?.harmonic && (
                <g
                  stroke="var(--colors-indigo-11)"
                  fill="none"
                  strokeWidth={1}
                  pointerEvents="none"
                >
                  <polygon points={`${x - 4},${y} ${x},${y - 4} ${x + 4},${y} ${x},${y + 4}`} />
                </g>
              )}
              {n.articulation?.palmMute && (
                <text
                  x={x}
                  y={y - 13}
                  fontSize="9"
                  textAnchor="middle"
                  fontWeight="600"
                  fill="var(--colors-fg-muted)"
                  pointerEvents="none"
                >
                  P.M.
                </text>
              )}
              {n.articulation?.slide && nextX !== null && nextY !== null && (
                <line
                  x1={x + 7}
                  y1={y}
                  x2={nextX - 7}
                  y2={nextY}
                  stroke="var(--colors-indigo-9)"
                  strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              {n.articulation?.legato && nextX !== null && nextY !== null && (
                <path
                  d={`M ${x},${y - 11} Q ${(x + nextX) / 2},${y - 20} ${nextX},${nextY - 11}`}
                  stroke="var(--colors-indigo-11)"
                  strokeWidth={1.2}
                  fill="none"
                  pointerEvents="none"
                />
              )}
              {n.articulation?.bend && (
                <text
                  x={x + 8}
                  y={y - 11}
                  fontSize="9"
                  fontWeight="600"
                  fill="var(--colors-tomato-11)"
                  pointerEvents="none"
                >
                  ↑{n.articulation.bend.semitones === 0.5 ? "½" : n.articulation.bend.semitones}
                </text>
              )}
              {n.articulation?.vibrato && (
                <path
                  d={`M ${x - 6},${y + 12} q 2,-3 4,0 t 4,0 t 4,0`}
                  stroke="var(--colors-indigo-11)"
                  strokeWidth={1}
                  fill="none"
                  pointerEvents="none"
                />
              )}
              {glyph.dotted && (
                <circle cx={x + 8} cy={y + 1} r={1.4} fill="var(--colors-indigo-11)" />
              )}
              {/* Duration bar below the fret box. Drawn only for notes
                  that don't already get a stem/beam (i.e., quarter and
                  longer) so whole/half/quarter look visibly different.
                  Clamped to the row's edge. */}
              {(() => {
                if (glyph.shortNote) return null;
                const endRaw = rowTimeToX(system, n.startSec + n.durSec);
                const endX = Math.min(endRaw, system.widthPx - 1);
                if (endX - x < 4) return null;
                return (
                  <line
                    x1={x + 6}
                    x2={endX - 1}
                    y1={y + 13}
                    y2={y + 13}
                    stroke="var(--colors-fg-muted)"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    pointerEvents="none"
                  />
                );
              })()}
            </g>
          );
        })}

        {/* Rhythm: stems + beams (groups of ≥ 2) or flags (singletons) */}
        {groups.map((g) => {
          if (g.beamLevels === 0) return null;
          const xs = g.indices.map((i) => rowTimeToX(system, notes[i].startSec));
          const key = `beam-${xs[0].toFixed(2)}-${xs.length}-${g.beamLevels}`;
          return (
            <g key={key} stroke="var(--colors-fg-muted)" fill="none">
              {xs.map((x) => (
                <line
                  key={`stem-${x.toFixed(3)}`}
                  x1={x}
                  x2={x}
                  y1={stemTop}
                  y2={stemBottom}
                  strokeWidth={1}
                />
              ))}
              {xs.length >= 2
                ? Array.from({ length: g.beamLevels }, (_, b) => {
                    const by = stemBottom - b * FLAG_GAP_PX;
                    return (
                      <line
                        key={`beam-line-${by}`}
                        x1={xs[0]}
                        x2={xs[xs.length - 1]}
                        y1={by}
                        y2={by}
                        strokeWidth={1.6}
                      />
                    );
                  })
                : Array.from({ length: g.beamLevels }, (_, b) => {
                    const fy = stemBottom - b * FLAG_GAP_PX;
                    return (
                      <line
                        key={`flag-${fy}`}
                        x1={xs[0]}
                        x2={xs[0] + FLAG_LENGTH_PX}
                        y1={fy}
                        y2={fy}
                        strokeWidth={1.4}
                      />
                    );
                  })}
            </g>
          );
        })}

        {/* Rubber-band selection rectangle. */}
        {marquee && (
          <rect
            x={Math.min(marquee.x1, marquee.x2)}
            y={Math.min(marquee.y1, marquee.y2)}
            width={Math.abs(marquee.x2 - marquee.x1)}
            height={Math.abs(marquee.y2 - marquee.y1)}
            fill="var(--colors-indigo-3)"
            fillOpacity="0.3"
            stroke="var(--colors-indigo-9)"
            strokeWidth={1}
            strokeDasharray="3 2"
            pointerEvents="none"
            data-marquee
          />
        )}

        {/* Rests. Two passes: inferred (ghost-grey, drawn from note
            gaps) and explicit (full opacity, clickable entities from
            edits.rests). Inferred rests that overlap any explicit rest
            are suppressed so we don't draw a ghost behind a real one. */}
        {(() => {
          const yMid =
            layout.topPadding + ((layout.stringCount - 1) * layout.stringLineSpacing) / 2;
          const overlapsExplicit = (rStart: number, rDur: number) =>
            explicitRests.some((e) => rStart < e.startSec + e.durSec && rStart + rDur > e.startSec);
          return (
            <>
              {rests
                .filter((r) => !overlapsExplicit(r.startSec, r.durSec))
                .map((r) => {
                  const x = rowTimeToX(system, r.startSec);
                  const xEnd = rowTimeToX(system, r.startSec + r.durSec);
                  const cx = (x + xEnd) / 2;
                  return (
                    <g
                      key={`rest-inf-${r.startSec.toFixed(3)}`}
                      fill="var(--colors-fg-muted)"
                      opacity={0.55}
                      onClick={(ev) => {
                        // Materialise this gap into an explicit rest so
                        // the next click can resize / delete it.
                        ev.stopPropagation();
                        ev.preventDefault();
                        onMaterialiseRest(r.startSec, r.durSec);
                      }}
                      className={css({ cursor: "pointer" })}
                    >
                      <rect
                        x={cx - 9}
                        y={yMid - 12}
                        width={18}
                        height={24}
                        fill="transparent"
                        style={{ pointerEvents: "all" }}
                      />
                      <RestGlyph kind={r.kind} cx={cx} y={yMid} />
                    </g>
                  );
                })}
              {explicitRests.map((r) => {
                const clipStart = Math.max(r.startSec, system.startSec);
                const clipEnd = Math.min(r.startSec + r.durSec, system.endSec);
                const x = rowTimeToX(system, clipStart);
                const xEnd = rowTimeToX(system, clipEnd);
                const cx = (x + xEnd) / 2;
                const kind = classifyDuration(r.durSec, localBeatDuration(r.startSec, beats.beats));
                const isSelected = selectedRestId === r.id;
                return (
                  <g
                    key={`rest-exp-${r.id}`}
                    fill={isSelected ? "var(--colors-tomato-11)" : "var(--colors-fg-default)"}
                    opacity={0.9}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      ev.preventDefault();
                      onPickRest(r.id);
                    }}
                    className={css({ cursor: "pointer" })}
                  >
                    {/* Invisible hit pad so small glyphs are easy to click. */}
                    <rect
                      x={cx - 9}
                      y={yMid - 12}
                      width={18}
                      height={24}
                      fill="transparent"
                      style={{ pointerEvents: "all" }}
                    />
                    <RestGlyph kind={kind} cx={cx} y={yMid} />
                  </g>
                );
              })}
            </>
          );
        })()}

        {/* Playhead — hidden until the rAF loop puts it on this row. */}
        <line
          ref={registerPlayhead}
          x1={-10}
          x2={-10}
          y1={layout.topPadding - 8}
          y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing + 8}
          stroke="var(--colors-indigo-9)"
          strokeWidth={2}
          data-playhead
        />
      </svg>

      {selectedNote && (
        <NoteEditPopover
          note={selectedNote}
          beats={beats.beats}
          anchorX={rowTimeToX(system, selectedNote.startSec)}
          anchorY={stringIndexToY(selectedNote.string, layout)}
          onEdit={onEdit}
          onClose={onClosePopover}
        />
      )}

      {addTarget && (
        <AddNotePopover
          target={addTarget}
          onAdd={onAddNote}
          onAddRest={() => {
            // Default to a quarter-note rest at the click's startSec.
            // The user can resize via the rest's edit popover afterwards.
            onMaterialiseRest(
              addTarget.startSec,
              localBeatDuration(addTarget.startSec, beats.beats),
            );
            onCloseAdd();
          }}
          onClose={onCloseAdd}
        />
      )}

      {selectedSection && selectedSectionIdx !== null && (
        <SectionEditPopover
          section={selectedSection}
          anchorX={rowTimeToX(system, selectedSection.startSec)}
          anchorY={2}
          durationSec={durationSec}
          onDelete={onDeleteSection}
          onResize={onResizeSection}
          onClose={onCloseSection}
        />
      )}

      {(() => {
        const sel = selectedRestId ? explicitRests.find((r) => r.id === selectedRestId) : null;
        if (!sel) return null;
        if (sel.startSec >= system.endSec || sel.startSec + sel.durSec <= system.startSec) {
          return null;
        }
        const x = rowTimeToX(system, Math.max(sel.startSec, system.startSec));
        const xEnd = rowTimeToX(system, Math.min(sel.startSec + sel.durSec, system.endSec));
        const yMid = layout.topPadding + ((layout.stringCount - 1) * layout.stringLineSpacing) / 2;
        const beatSec = localBeatDuration(sel.startSec, beats.beats);
        return (
          <RestEditPopover
            rest={sel}
            beatSec={beatSec}
            anchorX={(x + xEnd) / 2}
            anchorY={yMid}
            onResize={(patch) => onResizeRest(sel.id, patch)}
            onDelete={() => {
              onRemoveRest(sel.id);
              onCloseRest();
            }}
            onClose={onCloseRest}
          />
        );
      })()}
    </Box>
  );
}

interface RestEditPopoverProps {
  rest: RestEntry;
  /** Local quarter-note length, used to label duration buttons (W/H/Q…). */
  beatSec: number;
  anchorX: number;
  anchorY: number;
  onResize: (patch: { startSec?: number; durSec?: number }) => void;
  onDelete: () => void;
  onClose: () => void;
}

function RestEditPopover({
  rest,
  beatSec,
  anchorX,
  anchorY,
  onResize,
  onDelete,
  onClose,
}: RestEditPopoverProps) {
  return (
    <Popover.Root
      open
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      positioning={{ placement: "top" }}
    >
      <Popover.Anchor asChild>
        <styled.div
          position="absolute"
          width="14px"
          height="16px"
          pointerEvents="none"
          style={{ left: `${anchorX - 7}px`, top: `${anchorY - 8}px` }}
        />
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content>
            <Popover.Title>
              <styled.span fontSize="xs" opacity="0.7">
                rest @ {rest.startSec.toFixed(2)}s
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                duration
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb="3">
                {(
                  [
                    ["W", 4],
                    ["H", 2],
                    ["Q", 1],
                    ["E", 0.5],
                    ["S", 0.25],
                  ] as const
                ).map(([label, beatMul]) => {
                  const target = beatSec * beatMul;
                  const on = Math.abs(rest.durSec - target) / target < 0.01;
                  return (
                    <Button
                      key={`rdur-${label}`}
                      size="xs"
                      variant={on ? "solid" : "outline"}
                      onClick={() => {
                        if (on) return;
                        onResize({ durSec: target });
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
              </HStack>
              <Button size="xs" variant="outline" colorPalette="red" onClick={onDelete}>
                Delete rest
              </Button>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

interface AddNotePopoverProps {
  target: AddNoteTarget;
  onAdd: (string: number, fret: number) => void;
  onAddRest: () => void;
  onClose: () => void;
}

function AddNotePopover({ target, onAdd, onAddRest, onClose }: AddNotePopoverProps) {
  return (
    <Popover.Root
      open
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      positioning={{ placement: "top" }}
    >
      <Popover.Anchor asChild>
        <styled.div
          position="absolute"
          width="14px"
          height="16px"
          pointerEvents="none"
          style={{ left: `${target.x - 7}px`, top: `${target.y - 8}px` }}
        />
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content>
            <Popover.Title>
              <styled.span fontSize="xs" opacity="0.7">
                add on {STRING_LABELS[target.string]} @ {target.startSec.toFixed(2)}s
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                fret
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb="2">
                {ADD_NOTE_FRETS.map((fret) => (
                  <Button
                    key={`fret-${fret}`}
                    size="xs"
                    variant="outline"
                    onClick={() => onAdd(target.string, fret)}
                  >
                    {fret}
                  </Button>
                ))}
              </HStack>
              <Button size="xs" variant="outline" onClick={onAddRest}>
                Add rest
              </Button>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

interface SectionEditPopoverProps {
  section: SectionLabel;
  anchorX: number;
  anchorY: number;
  durationSec: number;
  onDelete: () => void;
  onResize: (patch: { startSec?: number; endSec?: number }) => void;
  onClose: () => void;
}

function SectionEditPopover({
  section,
  anchorX,
  anchorY,
  durationSec,
  onDelete,
  onResize,
  onClose,
}: SectionEditPopoverProps) {
  // Mirror the live section bounds so drag-to-resize updates the inputs.
  const [startStr, setStartStr] = useState(() => section.startSec.toFixed(2));
  const [endStr, setEndStr] = useState(() => section.endSec.toFixed(2));
  useEffect(() => {
    setStartStr(section.startSec.toFixed(2));
  }, [section.startSec]);
  useEffect(() => {
    setEndStr(section.endSec.toFixed(2));
  }, [section.endSec]);

  const MIN_GAP = 0.01;
  const commitStart = (raw: string) => {
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) {
      setStartStr(section.startSec.toFixed(2));
      return;
    }
    const clamped = Math.max(0, Math.min(v, section.endSec - MIN_GAP));
    onResize({ startSec: clamped });
  };
  const commitEnd = (raw: string) => {
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) {
      setEndStr(section.endSec.toFixed(2));
      return;
    }
    const upper = durationSec > 0 ? durationSec : v;
    const clamped = Math.max(section.startSec + MIN_GAP, Math.min(v, upper));
    onResize({ endSec: clamped });
  };

  return (
    <Popover.Root
      open
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      onInteractOutside={(e) => {
        // Pointer-down on a resize handle is "outside" the popover content
        // by DOM containment, so the dismissable layer would close us. Mark
        // handles with [data-section-handle] and veto dismiss for them so
        // dragging keeps the section selected.
        const target = e.detail.originalEvent.target as Element | null;
        if (target && "closest" in target && target.closest("[data-section-handle]")) {
          e.preventDefault();
        }
      }}
      positioning={{ placement: "top" }}
    >
      <Popover.Anchor asChild>
        <styled.div
          position="absolute"
          width="20px"
          height="16px"
          pointerEvents="none"
          style={{ left: `${anchorX}px`, top: `${anchorY}px` }}
        />
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content>
            <Popover.Title>
              <styled.span fontSize="xs" opacity="0.7" px="4" fontWeight={600}>
                {section.name}
                {section.repeats && section.repeats > 1 ? ` ×${section.repeats}` : ""}
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <VStack gap="2" alignItems="stretch">
                <HStack gap="2" alignItems="center">
                  <styled.label fontSize="xs" opacity="0.7" minWidth="36px">
                    Start
                  </styled.label>
                  <styled.input
                    type="number"
                    step="0.01"
                    min="0"
                    max={section.endSec - MIN_GAP}
                    value={startStr}
                    onChange={(e) => setStartStr(e.currentTarget.value)}
                    onBlur={(e) => commitStart(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitStart(e.currentTarget.value);
                    }}
                    aria-label="section start time in seconds"
                    width="80px"
                    px="1"
                    py="0"
                    borderWidth="1px"
                    borderColor="border"
                    borderRadius="l1"
                    bg="canvas"
                    fontSize="xs"
                    fontVariantNumeric="tabular-nums"
                    textAlign="right"
                  />
                  <styled.span fontSize="xs" opacity="0.5">
                    s
                  </styled.span>
                </HStack>
                <HStack gap="2" alignItems="center">
                  <styled.label fontSize="xs" opacity="0.7" minWidth="36px">
                    End
                  </styled.label>
                  <styled.input
                    type="number"
                    step="0.01"
                    min={section.startSec + MIN_GAP}
                    max={durationSec || undefined}
                    value={endStr}
                    onChange={(e) => setEndStr(e.currentTarget.value)}
                    onBlur={(e) => commitEnd(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEnd(e.currentTarget.value);
                    }}
                    aria-label="section end time in seconds"
                    width="80px"
                    px="1"
                    py="0"
                    borderWidth="1px"
                    borderColor="border"
                    borderRadius="l1"
                    bg="canvas"
                    fontSize="xs"
                    fontVariantNumeric="tabular-nums"
                    textAlign="right"
                  />
                  <styled.span fontSize="xs" opacity="0.5">
                    s
                  </styled.span>
                </HStack>
                <Button size="xs" variant="outline" colorPalette="red" onClick={onDelete}>
                  Delete section
                </Button>
              </VStack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

interface NoteEditPopoverProps {
  note: TabNote;
  /**
   * Sorted beat times in song-time, used to compute the local quarter-note
   * duration so the user can pick W/H/Q/E/S in musical terms.
   */
  beats: readonly number[];
  anchorX: number;
  anchorY: number;
  onEdit: (op: EditOp) => void;
  onClose: () => void;
}

/**
 * Per-duration rest glyph centred on (cx, y). Renders the canonical
 * SMuFL codepoint via the Bravura font (loaded once in main.tsx). One
 * `<text>` element per rest means the user can click / select / future-
 * delete each one as a real entity.
 */
function RestGlyph({ kind, cx, y }: { kind: RhythmKind; cx: number; y: number }) {
  let glyph = SMUFL_REST.quarter;
  if (kind === "whole") glyph = SMUFL_REST.whole;
  else if (kind === "half" || kind === "dottedHalf") glyph = SMUFL_REST.half;
  else if (kind === "quarter" || kind === "dottedQuarter") glyph = SMUFL_REST.quarter;
  else if (kind === "eighth" || kind === "dottedEighth") glyph = SMUFL_REST.eighth;
  else if (kind === "sixteenth") glyph = SMUFL_REST.sixteenth;
  return (
    <text
      x={cx}
      y={y}
      fontFamily="Bravura"
      fontSize="18"
      textAnchor="middle"
      dominantBaseline="middle"
      stroke="none"
    >
      {glyph}
    </text>
  );
}

function bestOctavePlacement(pitch: number) {
  // Lowest-fret placement is most ergonomic; preferred over the first-in-
  // array (E→A→D→G) result which biases toward low strings + high frets.
  const ps = enumeratePlacements(pitch, DEFAULT_TUNING);
  if (ps.length === 0) return null;
  let best = ps[0];
  for (const p of ps) {
    if (p.fret < best.fret) best = p;
  }
  return best;
}

function NoteEditPopover({ note, beats, anchorX, anchorY, onEdit, onClose }: NoteEditPopoverProps) {
  const id = tabNoteId(note);
  const placements = useMemo(() => enumeratePlacements(note.pitch, DEFAULT_TUNING), [note.pitch]);
  const octaveUp = useMemo(() => bestOctavePlacement(note.pitch + 12), [note.pitch]);
  const octaveDown = useMemo(() => bestOctavePlacement(note.pitch - 12), [note.pitch]);
  const noAlternates = placements.length === 0;
  // Local quarter-note length at this note's start, so W/H/Q/E/S map to
  // the song's actual tempo rather than a hardcoded constant.
  const beatSec = useMemo(() => localBeatDuration(note.startSec, beats), [note.startSec, beats]);

  return (
    <Popover.Root
      open
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      positioning={{ placement: "top" }}
    >
      <Popover.Anchor asChild>
        <styled.div
          position="absolute"
          width="14px"
          height="16px"
          pointerEvents="none"
          style={{ left: `${anchorX - 7}px`, top: `${anchorY - 8}px` }}
        />
      </Popover.Anchor>
      <Portal>
        <Popover.Positioner>
          <Popover.Content>
            <Popover.Title>
              <styled.span fontSize="xs" opacity="0.7">
                {pitchName(note.pitch)} (MIDI {note.pitch}) · {STRING_LABELS[note.string]} string,
                fret {note.fret}
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                alternates
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb={noAlternates ? "1" : "3"}>
                {noAlternates ? (
                  <styled.span fontSize="xs" opacity="0.5">
                    pitch is off the neck — try Oct {note.pitch > 60 ? "−" : "+"}
                  </styled.span>
                ) : (
                  placements.map((p) => {
                    const isCurrent = p.string === note.string && p.fret === note.fret;
                    return (
                      <Button
                        key={`${p.string}-${p.fret}`}
                        size="xs"
                        variant={isCurrent ? "solid" : "outline"}
                        onClick={() => {
                          if (isCurrent) return;
                          onEdit({ kind: "replace", id, string: p.string, fret: p.fret });
                        }}
                      >
                        {STRING_LABELS[p.string]}
                        {p.fret}
                      </Button>
                    );
                  })
                )}
              </HStack>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                duration
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb="3">
                {(
                  [
                    ["W", 4],
                    ["H", 2],
                    ["Q", 1],
                    ["E", 0.5],
                    ["S", 0.25],
                  ] as const
                ).map(([label, beatMul]) => {
                  const target = beatSec * beatMul;
                  // Highlight the closest button — durations land within 1% of the
                  // target after applyEdits rounding.
                  const on = Math.abs(note.durSec - target) / target < 0.01;
                  return (
                    <Button
                      key={`dur-${label}`}
                      size="xs"
                      variant={on ? "solid" : "outline"}
                      onClick={() => {
                        if (on) return;
                        onEdit({
                          kind: "replace",
                          id,
                          string: note.string,
                          fret: note.fret,
                          ...(note.articulation ? { articulation: note.articulation } : {}),
                          durSec: target,
                        });
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
                {(() => {
                  // "·" toggle: ×1.5 → dottedX, /1.5 → undotted. Highlights
                  // when classifyDuration already lands on a dotted variant.
                  const kind = classifyDuration(note.durSec, beatSec);
                  const dotted =
                    kind === "dottedHalf" || kind === "dottedQuarter" || kind === "dottedEighth";
                  return (
                    <Button
                      key="dur-dot"
                      size="xs"
                      variant={dotted ? "solid" : "outline"}
                      aria-label="toggle dotted"
                      onClick={() => {
                        const target = dotted ? note.durSec / 1.5 : note.durSec * 1.5;
                        onEdit({
                          kind: "replace",
                          id,
                          string: note.string,
                          fret: note.fret,
                          ...(note.articulation ? { articulation: note.articulation } : {}),
                          durSec: target,
                        });
                      }}
                    >
                      ·
                    </Button>
                  );
                })()}
              </HStack>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                articulation
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb="2">
                {(
                  [
                    ["staccato", "Stacc."],
                    ["accent", "Accent"],
                    ["ghost", "Ghost"],
                    ["palmMute", "P.M."],
                    ["harmonic", "Harm."],
                    ["slide", "Slide→"],
                    ["legato", "Legato→"],
                    ["vibrato", "Vibrato"],
                  ] as const
                ).map(([flag, label]) => {
                  const on = !!note.articulation?.[flag];
                  return (
                    <Button
                      key={flag}
                      size="xs"
                      variant={on ? "solid" : "outline"}
                      onClick={() => {
                        const next: Articulation = { ...note.articulation };
                        if (on) delete next[flag];
                        else next[flag] = true;
                        const cleaned = Object.keys(next).length > 0 ? next : undefined;
                        onEdit({
                          kind: "replace",
                          id,
                          string: note.string,
                          fret: note.fret,
                          ...(cleaned ? { articulation: cleaned } : {}),
                        });
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
              </HStack>
              <HStack gap="1" alignItems="center" mb="3">
                <styled.span fontSize="xs" opacity="0.7">
                  Bend
                </styled.span>
                {([0, 0.5, 1, 1.5, 2] as const).map((semi) => {
                  const cur = note.articulation?.bend;
                  const on = semi === 0 ? !cur : cur?.semitones === semi;
                  const label = semi === 0 ? "—" : semi === 0.5 ? "½" : String(semi);
                  return (
                    <Button
                      key={`bend-${semi}`}
                      size="xs"
                      variant={on ? "solid" : "outline"}
                      onClick={() => {
                        const next: Articulation = { ...note.articulation };
                        if (semi === 0) delete next.bend;
                        else next.bend = { semitones: semi, release: cur?.release };
                        const cleaned = Object.keys(next).length > 0 ? next : undefined;
                        onEdit({
                          kind: "replace",
                          id,
                          string: note.string,
                          fret: note.fret,
                          ...(cleaned ? { articulation: cleaned } : {}),
                        });
                      }}
                    >
                      {label}
                    </Button>
                  );
                })}
                {note.articulation?.bend && (
                  <Button
                    size="xs"
                    variant={note.articulation.bend.release ? "solid" : "outline"}
                    onClick={() => {
                      const cur = note.articulation?.bend;
                      if (!cur) return;
                      const next: Articulation = {
                        ...note.articulation,
                        bend: { semitones: cur.semitones, release: !cur.release },
                      };
                      onEdit({
                        kind: "replace",
                        id,
                        string: note.string,
                        fret: note.fret,
                        articulation: next,
                      });
                    }}
                    aria-label="bend release back to pitch"
                  >
                    rel
                  </Button>
                )}
              </HStack>
              <HStack gap="1" justifyContent="space-between">
                <HStack gap="1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!octaveDown}
                    onClick={() => {
                      if (!octaveDown) return;
                      onEdit({
                        kind: "add",
                        id: tabNoteId({ startSec: note.startSec, pitch: note.pitch - 12 }),
                        pitch: note.pitch - 12,
                        startSec: note.startSec,
                        durSec: note.durSec,
                        velocity: note.velocity,
                        string: octaveDown.string,
                        fret: octaveDown.fret,
                      });
                      onEdit({ kind: "delete", id });
                      onClose();
                    }}
                  >
                    Oct −
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!octaveUp}
                    onClick={() => {
                      if (!octaveUp) return;
                      onEdit({
                        kind: "add",
                        id: tabNoteId({ startSec: note.startSec, pitch: note.pitch + 12 }),
                        pitch: note.pitch + 12,
                        startSec: note.startSec,
                        durSec: note.durSec,
                        velocity: note.velocity,
                        string: octaveUp.string,
                        fret: octaveUp.fret,
                      });
                      onEdit({ kind: "delete", id });
                      onClose();
                    }}
                  >
                    Oct +
                  </Button>
                </HStack>
                <Button
                  size="xs"
                  variant="outline"
                  colorPalette="red"
                  onClick={() => {
                    onEdit({ kind: "delete", id });
                    onClose();
                  }}
                >
                  Delete
                </Button>
              </HStack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
