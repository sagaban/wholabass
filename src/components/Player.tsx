import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
// Vite ?url returns the URL of the worklet processor file so it can be
// loaded into the AudioContext via audioWorklet.addModule(). The package
// exports `./processor` as the public entry for this file.
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";
import { Box, Grid, GridItem, HStack, VStack, styled } from "styled-system/jsx";
import { Button, Dialog, Slider } from "@/components/ui";
import {
  StemEngine,
  STEM_NAMES,
  type LoopRegion,
  type StemBuffers,
  type StemName,
  type StretcherNode,
} from "@/audio/engine";
import {
  describeMidiTracks,
  extractTrackToMidi,
  findBestAlignment,
  loadBassNotes,
  pitchName,
  readMidiAlignmentMetadata,
  readMidiOnsets,
  suggestBassTrack,
  type BassNote,
  type MidiTrackInfo,
} from "@/audio/midi";
import { MidiSynth } from "@/audio/midi-synth";
import { StemMixer } from "@/components/StemMixer";
import { PianoRoll } from "@/components/PianoRoll";
import { Tab } from "@/components/Tab";
import {
  EMPTY_EDITS,
  addCut,
  addSection,
  applyCutsToNotes,
  applyNoteEditsToBass,
  normalizeMixerState,
  removeSectionAt,
  updateSectionAt,
  upsertEdit,
  type CutSpan,
  type EditOp,
  type EditsFile,
  type MixerState,
  type SectionLabel,
} from "@/tab/edits";

type LoadStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface PlayerProps {
  songId: string;
}

/**
 * Apply the user's MIDI offset + speed to a raw bass-note list. Pure;
 * exported only to share the formula between the synth load and the
 * tab load (Tab.tsx duplicates the same shape).
 */
function mapMidiNotes(raw: readonly BassNote[], offsetSec: number, speed: number): BassNote[] {
  if (offsetSec === 0 && speed === 1) return raw.slice();
  return raw.map((n) => ({
    pitch: n.pitch,
    velocity: n.velocity,
    startSec: n.startSec / speed + offsetSec,
    durSec: n.durSec / speed,
  }));
}

function normalizeEditsFile(raw: unknown): EditsFile {
  if (!raw || typeof raw !== "object") return EMPTY_EDITS;
  const r = raw as Partial<EditsFile>;
  const speedRaw = typeof r.midiSpeed === "number" ? r.midiSpeed : 1;
  const beatsSpeedRaw = typeof r.beatsSpeed === "number" ? r.beatsSpeed : 1;
  // Cuts are stored in sequential order, each in the time domain
  // produced by the prior cuts. Just shape-check each entry; no
  // sorting or merging — that would change the meaning of later cuts.
  const cuts = Array.isArray(r.cuts)
    ? r.cuts.filter(
        (c): c is CutSpan =>
          !!c &&
          typeof (c as CutSpan).startSec === "number" &&
          typeof (c as CutSpan).endSec === "number" &&
          (c as CutSpan).endSec > (c as CutSpan).startSec,
      )
    : [];
  const mixer = normalizeMixerState(r.mixer);
  return {
    version: typeof r.version === "number" ? r.version : EMPTY_EDITS.version,
    notes: Array.isArray(r.notes) ? (r.notes as EditOp[]) : [],
    sections: Array.isArray(r.sections) ? r.sections : [],
    cuts,
    midiOffsetSec: typeof r.midiOffsetSec === "number" ? r.midiOffsetSec : 0,
    // Clamp to a sane range so a corrupt edits file can't divide-by-zero
    // the time mapping or produce century-long bass notes.
    midiSpeed: speedRaw > 0.1 && speedRaw < 5 ? speedRaw : 1,
    beatsOffsetSec: typeof r.beatsOffsetSec === "number" ? r.beatsOffsetSec : 0,
    beatsSpeed: beatsSpeedRaw > 0.1 && beatsSpeedRaw < 5 ? beatsSpeedRaw : 1,
    playheadOffsetSec:
      typeof r.playheadOffsetSec === "number" && Math.abs(r.playheadOffsetSec) < 1
        ? r.playheadOffsetSec
        : 0,
    lyrics: typeof r.lyrics === "string" ? r.lyrics : "",
    ...(mixer ? { mixer } : {}),
  };
}

export function Player({ songId }: PlayerProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<StemEngine | null>(null);
  const synthRef = useRef<MidiSynth | null>(null);
  const bassNotesRef = useRef<BassNote[]>([]);
  const [load, setLoad] = useState<LoadStatus>({ kind: "loading" });
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [tempo, setTempo] = useState(1);
  const [showDebug, setShowDebug] = useState(false);
  // A and B are tracked independently. The engine only enters a real
  // loop when both are set and a < b; otherwise the markers are display-only.
  const [markA, setMarkA] = useState<number | null>(null);
  const [markB, setMarkB] = useState<number | null>(null);
  const loop: LoopRegion | null =
    markA !== null && markB !== null && markB > markA ? { a: markA, b: markB } : null;

  // Edits overlay (Phase 3). Lives at the Player level so the section
  // dialog has access to the A-B markers; Tab consumes it via props and
  // never writes to disk on its own.
  const [edits, setEditsState] = useState<EditsFile>(EMPTY_EDITS);
  const editsRef = useRef<EditsFile>(EMPTY_EDITS);
  const editsDirtyRef = useRef(false);
  // Undo / redo history. Snapshots are pushed BEFORE each mutation;
  // a transaction (drag, paste, bar-duplicate) batches multiple ops
  // into a single history entry. Capped so a long session can't grow
  // the heap unbounded.
  const HISTORY_CAP = 50;
  const historyRef = useRef<{ past: EditsFile[]; future: EditsFile[] }>({ past: [], future: [] });
  const inTransactionRef = useRef(false);
  const transactionStartRef = useRef<EditsFile | null>(null);
  // Tick state forces a re-render after undo/redo so callers reading
  // editsRef-derived state see fresh values. Not displayed directly.
  const [, setHistoryTick] = useState(0);
  const [sectionDialogOpen, setSectionDialogOpen] = useState(false);
  // Section playback countdown — number of remaining loop fires before
  // we clear the engine loop. -1 means "no section is driving the loop"
  // (the user is using A-B as a free-form scratch loop).
  const sectionLoopsLeftRef = useRef(-1);
  // Bumped after the user replaces bass.mid via upload, so Tab reloads.
  const [tabSourceRev, setTabSourceRev] = useState(0);

  const pushHistory = useCallback((snapshot: EditsFile) => {
    const h = historyRef.current;
    h.past.push(snapshot);
    if (h.past.length > HISTORY_CAP) h.past.shift();
    h.future = [];
    setHistoryTick((t) => t + 1);
  }, []);

  /**
   * Apply a functional edit to the EditsFile. Outside a transaction,
   * pushes the prior state to the undo stack. Inside a transaction,
   * the snapshot recorded by `transact` is pushed once at the end.
   */
  const mutateEdits = useCallback(
    (mutator: (prev: EditsFile) => EditsFile) => {
      const prev = editsRef.current;
      const next = mutator(prev);
      if (next === prev) return;
      if (!inTransactionRef.current) {
        pushHistory(prev);
      }
      editsRef.current = next;
      editsDirtyRef.current = true;
      setEditsState(next);
    },
    [pushHistory],
  );

  /** Run `fn` (which may call `mutateEdits` zero or more times) as a single undo step. */
  const transact = useCallback(
    (fn: () => void) => {
      if (inTransactionRef.current) {
        // Nested transact: just run; the outer one owns the history push.
        fn();
        return;
      }
      transactionStartRef.current = editsRef.current;
      inTransactionRef.current = true;
      try {
        fn();
      } finally {
        inTransactionRef.current = false;
      }
      const start = transactionStartRef.current;
      transactionStartRef.current = null;
      if (start && start !== editsRef.current) {
        pushHistory(start);
      }
    },
    [pushHistory],
  );

  /** Replace edits without touching history (used on song load). */
  const replaceEditsNoHistory = useCallback((next: EditsFile) => {
    editsRef.current = next;
    historyRef.current = { past: [], future: [] };
    setHistoryTick((t) => t + 1);
    setEditsState(next);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    const previous = h.past.pop() as EditsFile;
    h.future.push(editsRef.current);
    if (h.future.length > HISTORY_CAP) h.future.shift();
    editsRef.current = previous;
    editsDirtyRef.current = true;
    setEditsState(previous);
    setHistoryTick((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    const next = h.future.pop() as EditsFile;
    h.past.push(editsRef.current);
    if (h.past.length > HISTORY_CAP) h.past.shift();
    editsRef.current = next;
    editsDirtyRef.current = true;
    setEditsState(next);
    setHistoryTick((t) => t + 1);
  }, []);

  const onEdit = useCallback(
    (op: EditOp) => {
      mutateEdits((prev) => ({ ...prev, notes: upsertEdit(prev.notes, op) }));
    },
    [mutateEdits],
  );

  const onAddSection = useCallback(
    (name: string, repeats?: number) => {
      if (markA === null || markB === null || markB <= markA) return;
      mutateEdits((prev) => ({
        ...prev,
        sections: addSection(prev.sections, {
          startSec: markA,
          endSec: markB,
          name,
          repeats: repeats && repeats > 1 ? repeats : undefined,
        }),
      }));
    },
    [markA, markB, mutateEdits],
  );

  const onRemoveSectionAt = useCallback(
    (index: number) => {
      mutateEdits((prev) => ({ ...prev, sections: removeSectionAt(prev.sections, index) }));
    },
    [mutateEdits],
  );

  const onResizeSectionAt = useCallback(
    (index: number, patch: { startSec?: number; endSec?: number }) => {
      mutateEdits((prev) => {
        const cur = prev.sections[index];
        if (!cur) return prev;
        const startSec = patch.startSec ?? cur.startSec;
        const endSec = patch.endSec ?? cur.endSec;
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return prev;
        if (startSec < 0 || endSec <= startSec) return prev;
        if (startSec === cur.startSec && endSec === cur.endSec) return prev;
        return {
          ...prev,
          sections: updateSectionAt(prev.sections, index, { startSec, endSec }),
        };
      });
    },
    [mutateEdits],
  );

  const onSetMidiOffset = useCallback(
    (offsetSec: number) => {
      mutateEdits((prev) => ({ ...prev, midiOffsetSec: offsetSec }));
    },
    [mutateEdits],
  );

  const onAlignMidiToPlayhead = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    onSetMidiOffset(engine.getCurrentTime());
  }, [onSetMidiOffset]);

  const onSetMidiSpeed = useCallback(
    (speed: number) => {
      const clamped = Math.max(0.1, Math.min(5, speed));
      mutateEdits((prev) => ({ ...prev, midiSpeed: clamped }));
    },
    [mutateEdits],
  );

  const onSetBeatsOffset = useCallback(
    (offsetSec: number) => {
      mutateEdits((prev) => ({ ...prev, beatsOffsetSec: offsetSec }));
    },
    [mutateEdits],
  );

  const onSetBeatsSpeed = useCallback(
    (speed: number) => {
      const clamped = Math.max(0.1, Math.min(5, speed));
      mutateEdits((prev) => ({ ...prev, beatsSpeed: clamped }));
    },
    [mutateEdits],
  );

  const onSetPlayheadOffset = useCallback(
    (offsetSec: number) => {
      const clamped = Math.max(-1, Math.min(1, offsetSec));
      mutateEdits((prev) => ({ ...prev, playheadOffsetSec: clamped }));
    },
    [mutateEdits],
  );

  const onSetLyrics = useCallback(
    (lyrics: string) => {
      mutateEdits((prev) => (prev.lyrics === lyrics ? prev : { ...prev, lyrics }));
    },
    [mutateEdits],
  );

  /**
   * Persist mixer state without pushing onto the undo stack — Cmd+Z
   * undoing a volume slider drag isn't what the user expects, so we
   * write directly to the edits store + ref and trip the dirty bit so
   * the autosave still fires.
   */
  const onMixerChange = useCallback((next: MixerState) => {
    const prev = editsRef.current;
    if (prev.mixer === next) return;
    const updated: EditsFile = { ...prev, mixer: next };
    editsRef.current = updated;
    editsDirtyRef.current = true;
    setEditsState(updated);
  }, []);

  /**
   * Ripple-delete: drop a `[startSec, endSec)` audio-time span from
   * the MIDI. Notes inside vanish; later notes' startSec shift back by
   * the span's duration so the next surviving note slides into the
   * deleted slot. The audio recording is untouched. No-op for an
   * empty / inverted span.
   */
  const onRippleDelete = useCallback(
    (span: CutSpan) => {
      if (!Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)) return;
      if (span.endSec <= span.startSec) return;
      mutateEdits((prev) => ({ ...prev, cuts: addCut(prev.cuts ?? [], span) }));
    },
    [mutateEdits],
  );

  const [lyricsOpen, setLyricsOpen] = useState(false);
  // Width of the lyrics column on lg screens; persisted to
  // localStorage so the user's preferred width sticks across sessions.
  // Clamped to [240, 720] on read so a corrupt entry can't render an
  // unusable layout.
  const [lyricsWidth, setLyricsWidthState] = useState<number>(() => {
    if (typeof window === "undefined") return 320;
    const raw = window.localStorage.getItem("wholabass.lyricsWidth");
    const parsed = raw ? Number.parseInt(raw, 10) : 320;
    return Number.isFinite(parsed) ? Math.max(240, Math.min(720, parsed)) : 320;
  });
  const setLyricsWidth = useCallback((next: number) => {
    const clamped = Math.max(240, Math.min(720, Math.round(next)));
    setLyricsWidthState(clamped);
    try {
      window.localStorage.setItem("wholabass.lyricsWidth", String(clamped));
    } catch {
      // localStorage unavailable (private mode, sandboxing) — width
      // just won't persist; not worth surfacing.
    }
  }, []);

  /**
   * Auto-match heuristic. Reads the song's beats.json for the
   * audio-side tempo + first downbeat, and bass.mid for the MIDI's
   * native tempo + earliest note. Sets both speed (audio/midi BPM)
   * and offset (audio first beat aligned to first MIDI note) as a
   * single undo step. Returns a one-line summary or null on failure.
   */
  const onAutoMatchMidi = useCallback(async (): Promise<string | null> => {
    try {
      const beats = await invoke<{ tempo_bpm: number; beats: number[] }>("read_beats", {
        songId,
      });
      if (!beats.beats.length) return null;
      const bytes = await invoke<ArrayBuffer>("read_midi", { songId });
      const meta = readMidiAlignmentMetadata(bytes);
      if (!meta) return null;

      // Compute a folded base speed from BPM ratios. Used as the anchor
      // for the cross-correlation sweep — that way half-/double-time
      // mismatches from either side are handled before DSP work starts.
      const rawSpeed =
        meta.tempoBpm > 0 ? Math.max(0.1, Math.min(5, beats.tempo_bpm / meta.tempoBpm)) : 1;
      let baseSpeed = rawSpeed;
      while (baseSpeed < 0.7) baseSpeed *= 2;
      while (baseSpeed > 1.6) baseSpeed /= 2;

      // Pull audio onsets + MIDI onsets, then cross-correlate.
      // Drums give a much cleaner pulse than the bass stem (kick + snare
      // hit on most beats; bass can rest, slide, or ornament). Prefer
      // drums; fall back to bass if the drum stem is missing or silent.
      // Limited to the first ~25 s so mid-song tempo drift /
      // missing-note ornamentation doesn't skew the fit.
      let audioOnsets: number[] = [];
      let audioSource: "drums" | "bass" | "none" = "none";
      try {
        audioOnsets = await invoke<number[]>("drum_onsets", { songId });
        if (audioOnsets.length > 0) audioSource = "drums";
      } catch {
        audioOnsets = [];
      }
      if (audioOnsets.length === 0) {
        try {
          audioOnsets = await invoke<number[]>("bass_onsets", { songId });
          if (audioOnsets.length > 0) audioSource = "bass";
        } catch {
          audioOnsets = [];
        }
      }
      const midiOnsets = readMidiOnsets(bytes);

      let speed = baseSpeed;
      let offset = (beats.beats[0] ?? 0) - meta.firstNoteSec / baseSpeed;
      let matches = 0;
      let totalMidiOnsets = midiOnsets.length;
      let usedCorrelation = false;

      if (audioOnsets.length > 0 && midiOnsets.length > 0) {
        const result = findBestAlignment(audioOnsets, midiOnsets, baseSpeed, {
          prefixSec: 25,
        });
        if (result) {
          speed = result.speed;
          offset = result.offset;
          matches = result.matches;
          totalMidiOnsets = result.totalMidiOnsets;
          usedCorrelation = true;
        }
      }

      transact(() => {
        mutateEdits((prev) => ({ ...prev, midiSpeed: speed, midiOffsetSec: offset }));
      });

      const summary = `audio ${beats.tempo_bpm.toFixed(1)} bpm / midi ${meta.tempoBpm.toFixed(
        1,
      )} bpm → ${(speed * 100).toFixed(2)}%, offset ${offset.toFixed(2)}s`;
      if (!usedCorrelation) return `${summary} (BPM ratio only — no audio onsets)`;
      return `${summary} (matched ${matches}/${totalMidiOnsets} MIDI onsets to ${audioSource} pulse, first 25 s)`;
    } catch {
      return null;
    }
  }, [songId, transact, mutateEdits]);

  const onSetSectionRepeats = useCallback(
    (index: number, repeats: number) => {
      mutateEdits((prev) => ({
        ...prev,
        // Store undefined for repeats=1 to keep the on-disk shape minimal
        // (matches the convention used at create time).
        sections: updateSectionAt(prev.sections, index, {
          repeats: repeats > 1 ? repeats : undefined,
        }),
      }));
    },
    [mutateEdits],
  );

  // Load + autosave the edits overlay alongside stems. Loads bypass
  // the history (a song change isn't an undoable action). On load,
  // also seed the lyrics-panel toggle: if the song already has lyrics
  // saved, the panel auto-opens; subsequent Show/Hide clicks stick
  // until the next song change.
  useEffect(() => {
    let cancelled = false;
    editsDirtyRef.current = false;
    void (async () => {
      try {
        const raw = await invoke<unknown>("read_edits", { songId });
        if (cancelled) return;
        const next = normalizeEditsFile(raw);
        replaceEditsNoHistory(next);
        setLyricsOpen(!!next.lyrics?.trim());
      } catch {
        if (!cancelled) {
          replaceEditsNoHistory(EMPTY_EDITS);
          setLyricsOpen(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId, replaceEditsNoHistory]);

  useEffect(() => {
    if (!editsDirtyRef.current) return;
    const timer = setTimeout(() => {
      void invoke("write_edits", { songId, edits });
    }, 500);
    return () => clearTimeout(timer);
  }, [edits, songId]);

  // Cmd+Z / Cmd+Shift+Z (or Ctrl on non-Mac) undo / redo. Skip when
  // typing in a text field so the section dialog still works normally.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        undo();
        e.preventDefault();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        redo();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Load stems whenever songId changes.
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    setIsPlaying(false);
    setPosition(0);

    void (async () => {
      try {
        if (!ctxRef.current) {
          ctxRef.current = new AudioContext();
        }
        const ctx = ctxRef.current;
        // Idempotent: addModule on the same URL is a no-op for subsequent
        // engine instances on the same context.
        await SoundTouchNode.register(ctx, processorUrl);

        if (!engineRef.current) {
          engineRef.current = new StemEngine(
            ctx,
            (c) => new SoundTouchNode(c) as unknown as StretcherNode,
          );
        }
        if (!synthRef.current) {
          synthRef.current = new MidiSynth(ctx);
        }

        const buffers = await loadStemBuffers(ctx, songId);
        if (cancelled) return;

        const engine = engineRef.current;
        engine.load(buffers);
        setDuration(engine.duration);
        setLoad({ kind: "ready" });
      } catch (err: unknown) {
        if (!cancelled) {
          setLoad({ kind: "error", message: String(err) });
        }
      }
    })();

    return () => {
      cancelled = true;
      const engine = engineRef.current;
      if (engine?.isPlaying) engine.pause();
      synthRef.current?.cancel();
    };
  }, [songId]);

  // Load bass MIDI separately so a user-uploaded replacement (which
  // bumps tabSourceRev) can refresh the synth without re-decoding the
  // 4 stem WAVs. The mapped result is cached so the edits/cuts pass
  // below can re-run synchronously without re-reading the file — that
  // way a ripple-delete during playback doesn't produce a 50-100 ms
  // gap of cancelled-but-not-rescheduled audio.
  const midiOffsetSec = edits.midiOffsetSec ?? 0;
  const midiSpeed = edits.midiSpeed && edits.midiSpeed > 0 ? edits.midiSpeed : 1;
  const editNotes = edits.notes;
  const cuts = useMemo(() => edits.cuts ?? [], [edits.cuts]);
  const [mappedBass, setMappedBass] = useState<readonly BassNote[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await loadBassNotes(songId).catch(() => [] as BassNote[]);
      if (cancelled) return;
      setMappedBass(mapMidiNotes(raw, midiOffsetSec, midiSpeed));
    })();
    return () => {
      cancelled = true;
    };
  }, [songId, tabSourceRev, midiOffsetSec, midiSpeed]);

  // Re-apply cuts + note edits whenever any of those inputs change.
  // Cuts run first (filter inside, shift later notes back) so edit ids
  // reference the same shifted time domain that the renderer + synth
  // use. Synchronous — no async gap — so a ripple-delete mid-playback
  // cancels and re-schedules in the same frame.
  useEffect(() => {
    const shifted = applyCutsToNotes(mappedBass, cuts);
    const notes = applyNoteEditsToBass(shifted, editNotes);
    bassNotesRef.current = notes;
    const synth = synthRef.current;
    if (!synth) return;
    synth.cancel();
    synth.setNotes(notes);
    const engine = engineRef.current;
    if (engine?.isPlaying) {
      synth.schedule(engine.getCurrentTime(), engine.getTempo());
    }
  }, [mappedBass, editNotes, cuts]);

  // Drive the position display while playing; tick the loop watcher too.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (engine) {
        // tickLoop returns true (and re-plays at A) when the playhead
        // crosses B; on the next read we pick up the looped position.
        if (engine.tickLoop()) {
          synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
          // Section-driven playback: count loop fires and clear the
          // loop when the configured repeat count is exhausted, so the
          // song continues past B instead of looping forever.
          if (sectionLoopsLeftRef.current > 0) {
            sectionLoopsLeftRef.current -= 1;
            if (sectionLoopsLeftRef.current === 0) {
              engine.clearLoop();
              setMarkA(null);
              setMarkB(null);
              sectionLoopsLeftRef.current = -1;
            }
          }
        }
        // The clock + seek slider share the same visual-offset nudge as
        // the tab playhead so they all move in lockstep. Read via the
        // ref so changing the offset doesn't tear down the rAF loop.
        const t = engine.getCurrentTime() + (editsRef.current.playheadOffsetSec ?? 0);
        setPosition(t);
        if (t >= engine.duration && !engine.getLoop()) {
          setIsPlaying(false);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  const onTogglePlay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !engine.hasBuffers) return;
    void ctxRef.current?.resume();
    if (engine.isPlaying) {
      engine.pause();
      synthRef.current?.cancel();
      setPosition(engine.getCurrentTime());
      setIsPlaying(false);
    } else {
      engine.play();
      synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
      setIsPlaying(true);
    }
  }, []);

  // Spacebar = play/pause when no text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || t.isContentEditable) {
          return;
        }
      }
      e.preventDefault();
      onTogglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTogglePlay]);

  const onSeek = (value: number) => {
    const engine = engineRef.current;
    if (!engine || !engine.hasBuffers) return;
    engine.seek(value);
    setPosition(engine.getCurrentTime());
    if (engine.isPlaying) {
      synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
    } else {
      synthRef.current?.cancel();
    }
  };

  const onTempo = (value: number) => {
    setTempo(value);
    const engine = engineRef.current;
    engine?.setTempo(value);
    if (engine?.isPlaying) {
      synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
    }
  };

  const onSetA = () => {
    const engine = engineRef.current;
    if (!engine) return;
    sectionLoopsLeftRef.current = -1;
    const a = engine.getCurrentTime();
    setMarkA(a);
    // Activate the loop only if B is present and ahead of A.
    if (markB !== null && markB > a) {
      engine.setLoop({ a, b: markB });
    } else {
      engine.clearLoop();
    }
  };

  const onSetB = () => {
    const engine = engineRef.current;
    if (!engine) return;
    sectionLoopsLeftRef.current = -1;
    const b = engine.getCurrentTime();
    setMarkB(b);
    if (markA !== null && b > markA) {
      engine.setLoop({ a: markA, b });
    } else {
      engine.clearLoop();
    }
  };

  const onClearLoop = () => {
    engineRef.current?.clearLoop();
    sectionLoopsLeftRef.current = -1;
    setMarkA(null);
    setMarkB(null);
  };

  const onPlaySection = useCallback(
    (idx: number) => {
      const engine = engineRef.current;
      const ctx = ctxRef.current;
      if (!engine || !engine.hasBuffers) return;
      const section = edits.sections[idx];
      if (!section) return;
      void ctx?.resume();
      const repeats = section.repeats ?? 1;
      engine.seek(section.startSec);
      setMarkA(section.startSec);
      setMarkB(section.endSec);
      if (repeats > 1) {
        engine.setLoop({ a: section.startSec, b: section.endSec });
        sectionLoopsLeftRef.current = repeats - 1;
      } else {
        engine.clearLoop();
        sectionLoopsLeftRef.current = -1;
      }
      if (!engine.isPlaying) {
        engine.play();
        synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
        setIsPlaying(true);
      } else {
        synthRef.current?.schedule(engine.getCurrentTime(), engine.getTempo());
      }
      setPosition(engine.getCurrentTime());
    },
    [edits.sections],
  );

  if (load.kind === "loading") {
    return (
      <Box mt="4" opacity="0.7">
        loading stems...
      </Box>
    );
  }
  if (load.kind === "error") {
    return (
      <Box mt="4" color="error">
        load error: {load.message}
      </Box>
    );
  }

  return (
    <Grid
      mt="5"
      gap="6"
      // The dynamic lyrics-column width flows through a CSS variable
      // because Panda only extracts responsive variants (`lg: "..."`)
      // from static strings — a template literal there silently drops
      // the lg rule and the layout collapses to base / 1fr.
      style={{ ["--lyrics-w" as string]: `${lyricsWidth}px` }}
      gridTemplateColumns={{
        base: "1fr",
        lg: lyricsOpen ? "minmax(320px, 380px) 1fr var(--lyrics-w)" : "minmax(320px, 380px) 1fr",
      }}
      alignItems="start"
      w="full"
    >
      <GridItem>
        <VStack gap="3" alignItems="stretch">
          <HStack gap="3" alignItems="center">
            <Button onClick={onTogglePlay} size="sm">
              {isPlaying ? "Pause" : "Play"}
            </Button>
            <styled.span fontVariantNumeric="tabular-nums" opacity="0.85">
              {fmtTime(position)} / {fmtTime(duration)}
            </styled.span>
          </HStack>

          <Slider.Root
            value={[position]}
            onValueChange={(d) => onSeek(d.value[0] ?? 0)}
            min={0}
            max={duration}
            step={0.05}
            aria-label={["seek"]}
          >
            <Slider.Control>
              <Slider.Track>
                <Slider.Range />
              </Slider.Track>
              <Slider.Thumb index={0}>
                <Slider.HiddenInput />
              </Slider.Thumb>
            </Slider.Control>
            {(markA !== null || markB !== null) && (
              <Slider.Marks
                marks={[
                  ...(markA !== null ? [{ value: markA, label: "A" }] : []),
                  ...(markB !== null ? [{ value: markB, label: "B" }] : []),
                ]}
              />
            )}
          </Slider.Root>

          <HStack
            gap="2"
            alignItems="center"
            justifyContent="space-between"
            flexWrap="wrap"
            mt={markA !== null || markB !== null ? "3" : "0"}
          >
            <HStack gap="2" alignItems="center">
              <Button size="xs" variant={markA !== null ? "solid" : "outline"} onClick={onSetA}>
                Set A
              </Button>
              <Button size="xs" variant={markB !== null ? "solid" : "outline"} onClick={onSetB}>
                Set B
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={onClearLoop}
                disabled={markA === null && markB === null}
              >
                Clear A-B
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setSectionDialogOpen(true)}
                disabled={loop === null}
                aria-label="name section between A and B"
              >
                Name section
              </Button>
            </HStack>
            <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
              {loop
                ? `Loop ${fmtTime(loop.a)} → ${fmtTime(loop.b)}`
                : `A=${markA !== null ? fmtTime(markA) : "—"} · B=${markB !== null ? fmtTime(markB) : "—"}`}
            </styled.span>
          </HStack>

          <HStack gap="3" alignItems="center">
            <styled.span fontSize="sm" opacity="0.85" minWidth="56px">
              Tempo
            </styled.span>
            <Box flex="1">
              <Slider.Root
                value={[tempo]}
                onValueChange={(d) => onTempo(d.value[0] ?? 1)}
                min={0.5}
                max={1}
                step={0.01}
                aria-label={["tempo"]}
              >
                <Slider.Control>
                  <Slider.Track>
                    <Slider.Range />
                  </Slider.Track>
                  <Slider.Thumb index={0}>
                    <Slider.HiddenInput />
                  </Slider.Thumb>
                </Slider.Control>
              </Slider.Root>
            </Box>
            <styled.span
              fontVariantNumeric="tabular-nums"
              fontSize="sm"
              opacity="0.7"
              minWidth="42px"
              textAlign="right"
            >
              {Math.round(tempo * 100)}%
            </styled.span>
          </HStack>

          <TabSourceCard
            songId={songId}
            offsetSec={midiOffsetSec}
            speed={midiSpeed}
            onSetOffset={onSetMidiOffset}
            onAlignToPlayhead={onAlignMidiToPlayhead}
            onSetSpeed={onSetMidiSpeed}
            onAutoMatch={onAutoMatchMidi}
            onReplaced={() => {
              // Clear note-level edits AND ripple-delete cuts — both
              // were anchored to the previous bass.mid's bar timing
              // and would otherwise produce phantom extras / a hole in
              // the wrong place. Wrapped so a single Cmd+Z brings them
              // back if the user wanted to preserve them.
              mutateEdits((prev) => {
                const noNotes = prev.notes.length === 0;
                const noCuts = !prev.cuts || prev.cuts.length === 0;
                if (noNotes && noCuts) return prev;
                return { ...prev, notes: [], cuts: [] };
              });
              setTabSourceRev((r) => r + 1);
            }}
          />

          <BeatsCalibrationCard
            offsetSec={edits.beatsOffsetSec ?? 0}
            speed={edits.beatsSpeed ?? 1}
            playheadOffsetSec={edits.playheadOffsetSec ?? 0}
            onSetOffset={onSetBeatsOffset}
            onSetSpeed={onSetBeatsSpeed}
            onSetPlayheadOffset={onSetPlayheadOffset}
          />

          <SectionsList
            sections={edits.sections}
            onPlay={onPlaySection}
            onRemoveAt={onRemoveSectionAt}
            onSetRepeats={onSetSectionRepeats}
          />

          {engineRef.current && synthRef.current && (
            <StemMixer
              engine={engineRef.current}
              synth={synthRef.current}
              value={edits.mixer}
              onChange={onMixerChange}
            />
          )}

          <HStack justifyContent="flex-end" gap="2">
            <Button size="xs" variant="subtle" onClick={() => setLyricsOpen((v) => !v)}>
              {lyricsOpen ? "Hide lyrics" : "Show lyrics"}
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setShowDebug((v) => !v)}>
              {showDebug ? "Hide debug" : "Show debug"}
            </Button>
          </HStack>
          {showDebug && engineRef.current && (
            <PianoRoll songId={songId} engine={engineRef.current} />
          )}
        </VStack>
      </GridItem>

      <GridItem minWidth="0">
        {engineRef.current && (
          <Tab
            songId={songId}
            tabSourceRev={tabSourceRev}
            engine={engineRef.current}
            durationSec={duration}
            edits={edits}
            onEdit={onEdit}
            transact={transact}
            onRemoveSectionAt={onRemoveSectionAt}
            onResizeSectionAt={onResizeSectionAt}
            onRippleDelete={onRippleDelete}
          />
        )}
      </GridItem>

      {lyricsOpen && (
        <GridItem minWidth="0">
          <LyricsPanel
            value={edits.lyrics ?? ""}
            onChange={onSetLyrics}
            onClose={() => setLyricsOpen(false)}
            width={lyricsWidth}
            onResize={setLyricsWidth}
          />
        </GridItem>
      )}

      <SectionDialog
        open={sectionDialogOpen}
        onOpenChange={setSectionDialogOpen}
        onSave={(name, repeats) => {
          onAddSection(name, repeats);
          setSectionDialogOpen(false);
        }}
      />
    </Grid>
  );
}

// Cache decoded stems across navigations + StrictMode replays. Bounded to a
// few entries so RAM usage stays in check (a 4-min song is ~170 MB decoded).
const BUFFERS_CACHE_LIMIT = 3;
const buffersCache = new Map<string, StemBuffers>();
const inFlight = new Map<string, Promise<StemBuffers>>();

function rememberBuffers(songId: string, buffers: StemBuffers): void {
  buffersCache.delete(songId);
  buffersCache.set(songId, buffers);
  while (buffersCache.size > BUFFERS_CACHE_LIMIT) {
    const oldest = buffersCache.keys().next().value;
    if (oldest === undefined) break;
    buffersCache.delete(oldest);
  }
}

async function loadStemBuffers(ctx: AudioContext, songId: string): Promise<StemBuffers> {
  const cached = buffersCache.get(songId);
  if (cached) return cached;
  const existing = inFlight.get(songId);
  if (existing) return existing;
  const promise = (async () => {
    const entries = await Promise.all(
      STEM_NAMES.map(async (stem) => [stem, await loadStem(ctx, songId, stem)] as const),
    );
    const out = {} as StemBuffers;
    for (const [name, buf] of entries) {
      out[name] = buf;
    }
    rememberBuffers(songId, out);
    return out;
  })();
  inFlight.set(songId, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(songId);
  }
}

async function loadStem(ctx: AudioContext, songId: string, stem: StemName): Promise<AudioBuffer> {
  const bytes = await invoke<ArrayBuffer>("read_stem", { songId, stem });
  // decodeAudioData detaches the input buffer on some platforms; copy to be safe.
  return ctx.decodeAudioData(bytes.slice(0));
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00.00";
  // Work in centiseconds so 59.999 doesn't carry-flip the minute when
  // we render two decimals.
  const cs = Math.floor(seconds * 100);
  const m = Math.floor(cs / 6000);
  const rem = cs % 6000;
  const s = Math.floor(rem / 100);
  const hh = rem % 100;
  return `${m}:${s.toString().padStart(2, "0")}.${hh.toString().padStart(2, "0")}`;
}

interface BeatsCalibrationCardProps {
  offsetSec: number;
  speed: number;
  playheadOffsetSec: number;
  onSetOffset: (sec: number) => void;
  onSetSpeed: (speed: number) => void;
  onSetPlayheadOffset: (sec: number) => void;
}

function BeatsCalibrationCard({
  offsetSec,
  speed,
  playheadOffsetSec,
  onSetOffset,
  onSetSpeed,
  onSetPlayheadOffset,
}: BeatsCalibrationCardProps) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <Box
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l3"
      display="flex"
      flexDirection="column"
      gap="2"
    >
      <styled.button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "expand beat grid" : "collapse beat grid"}
        display="flex"
        alignItems="center"
        gap="1"
        bg="transparent"
        border="0"
        p="0"
        cursor="pointer"
        fontSize="sm"
        fontWeight="semibold"
        color="inherit"
      >
        <styled.span display="inline-block" width="3" textAlign="center">
          {collapsed ? "▸" : "▾"}
        </styled.span>
        Beat grid
      </styled.button>
      {!collapsed && (
        <>
          <OffsetControls
            offsetSec={offsetSec}
            onSetOffset={onSetOffset}
            label="Beats offset"
          />
          <SpeedControls speed={speed} onSetSpeed={onSetSpeed} label="Beats speed" />
          <OffsetControls
            offsetSec={playheadOffsetSec}
            onSetOffset={onSetPlayheadOffset}
            label="Playhead sync"
          />
        </>
      )}
    </Box>
  );
}

interface TabSourceCardProps {
  songId: string;
  offsetSec: number;
  speed: number;
  onSetOffset: (sec: number) => void;
  onAlignToPlayhead: () => void;
  onSetSpeed: (speed: number) => void;
  onAutoMatch: () => Promise<string | null>;
  onReplaced: () => void;
}

function TabSourceCard({
  songId,
  offsetSec,
  speed,
  onSetOffset,
  onAlignToPlayhead,
  onSetSpeed,
  onAutoMatch,
  onReplaced,
}: TabSourceCardProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "uploading" }
    | { kind: "transcribing"; progress: number; stage: string }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [collapsed, setCollapsed] = useState(false);
  const [pendingPick, setPendingPick] = useState<{
    buffer: ArrayBuffer;
    tracks: MidiTrackInfo[];
    suggested: number;
  } | null>(null);

  // Subscribe to sidecar progress while a transcription is running. The
  // shared `ingest:progress` channel is also used by library-level
  // ingests, but only one long-running sidecar call exists at a time, so
  // every event during transcription belongs to this card's call.
  const transcribing = status.kind === "transcribing";
  useEffect(() => {
    if (!transcribing) return;
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void listen<{ progress: number; stage: string }>("ingest:progress", (event) => {
      setStatus((prev) =>
        prev.kind === "transcribing"
          ? {
              kind: "transcribing",
              progress: event.payload.progress,
              stage: event.payload.stage,
            }
          : prev,
      );
    }).then((fn) => {
      if (!mounted) fn();
      else unlisten = fn;
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [transcribing]);

  const commitBytes = async (bytes: Uint8Array) => {
    setStatus({ kind: "uploading" });
    try {
      await invoke("replace_bass_midi", { songId, bytes: Array.from(bytes) });
      setStatus({ kind: "ok" });
      onReplaced();
    } catch (err: unknown) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const onFile = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const tracks = describeMidiTracks(buffer);
      const populated = tracks.filter((t) => t.noteCount > 0);
      // Single populated track → upload as-is, no picker.
      if (populated.length <= 1) {
        await commitBytes(new Uint8Array(buffer));
        return;
      }
      setPendingPick({ buffer, tracks, suggested: suggestBassTrack(tracks) });
    } catch (err: unknown) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const onPickTrack = async (index: number) => {
    if (!pendingPick) return;
    try {
      const bytes = extractTrackToMidi(pendingPick.buffer, index);
      setPendingPick(null);
      await commitBytes(bytes);
    } catch (err: unknown) {
      setStatus({ kind: "error", message: String(err) });
      setPendingPick(null);
    }
  };

  // Transcription engine + preset travel together as "engine:preset"
  // so the dropdown can offer the cross-product without a 2D picker.
  const [transcribeChoice, setTranscribeChoice] = useState<string>("basic_pitch:balanced");
  const onTranscribe = async () => {
    setStatus({ kind: "transcribing", progress: 0, stage: "starting" });
    try {
      const [engine, preset] = transcribeChoice.split(":");
      await invoke("transcribe_song", { songId, engine, preset });
      setStatus({ kind: "ok" });
      onReplaced();
    } catch (err: unknown) {
      setStatus({ kind: "error", message: String(err) });
    }
  };

  const busy = status.kind === "uploading" || status.kind === "transcribing";

  return (
    <Box
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l3"
      display="flex"
      flexDirection="column"
      gap="2"
    >
      <HStack justifyContent="space-between" alignItems="center">
        <styled.button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "expand tab source" : "collapse tab source"}
          display="flex"
          alignItems="center"
          gap="1"
          bg="transparent"
          border="0"
          p="0"
          cursor="pointer"
          fontSize="sm"
          fontWeight="semibold"
          color="inherit"
        >
          <styled.span
            display="inline-block"
            width="3"
            textAlign="center"
            opacity="0.7"
            fontSize="xs"
          >
            {collapsed ? "▸" : "▾"}
          </styled.span>
          Tab source
        </styled.button>
        {collapsed && status.kind === "transcribing" && (
          <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
            transcribing… {Math.round(status.progress)}%
          </styled.span>
        )}
        {collapsed && status.kind === "uploading" && (
          <styled.span fontSize="xs" opacity="0.7">
            uploading…
          </styled.span>
        )}
      </HStack>
      {!collapsed && (
        <>
          <styled.span fontSize="xs" opacity="0.6">
            Auto-transcribe the isolated bass with basic-pitch, or upload your own MIDI (e.g., a
            Guitar Pro export saved as .mid).
          </styled.span>
          <HStack gap="2" alignItems="center" flexWrap="wrap">
            <Button size="xs" variant="outline" onClick={onTranscribe} disabled={busy}>
              Auto-transcribe
            </Button>
            <styled.select
              value={transcribeChoice}
              onChange={(e) => setTranscribeChoice(e.currentTarget.value)}
              disabled={busy}
              aria-label="transcription model + preset"
              fontSize="xs"
              px="1"
              py="0.5"
              borderWidth="1px"
              borderColor="border"
              borderRadius="l1"
              bg="canvas"
            >
              <optgroup label="basic-pitch (Spotify)">
                <option value="basic_pitch:balanced">balanced</option>
                <option value="basic_pitch:sensitive">sensitive (busy lines)</option>
                <option value="basic_pitch:monophonic">monophonic (sustained)</option>
              </optgroup>
              <optgroup label="CREPE (monophonic)">
                <option value="crepe:balanced">balanced</option>
                <option value="crepe:sensitive">sensitive</option>
              </optgroup>
            </styled.select>
            <Button
              size="xs"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              Upload .mid…
            </Button>
            <styled.input
              ref={inputRef}
              type="file"
              accept=".mid,.midi,audio/midi"
              display="none"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void onFile(f);
                e.currentTarget.value = "";
              }}
            />
            {status.kind === "uploading" && (
              <styled.span fontSize="xs" opacity="0.6">
                uploading…
              </styled.span>
            )}
            {status.kind === "ok" && (
              <styled.span fontSize="xs" color="indigo.11">
                updated ✓
              </styled.span>
            )}
            {status.kind === "error" && (
              <styled.span fontSize="xs" color="error">
                {status.message}
              </styled.span>
            )}
          </HStack>

          {status.kind === "transcribing" && (
            <TranscribeProgress progress={status.progress} stage={status.stage} />
          )}

          <OffsetControls
            offsetSec={offsetSec}
            onSetOffset={onSetOffset}
            onAlignToPlayhead={onAlignToPlayhead}
          />
          <SpeedControls speed={speed} onSetSpeed={onSetSpeed} />
          <AutoMatchRow onAutoMatch={onAutoMatch} />
        </>
      )}

      <TrackPickerDialog
        open={pendingPick !== null}
        tracks={pendingPick?.tracks ?? []}
        suggested={pendingPick?.suggested ?? 0}
        onPick={onPickTrack}
        onCancel={() => setPendingPick(null)}
      />
    </Box>
  );
}

interface TranscribeProgressProps {
  progress: number;
  stage: string;
}

function TranscribeProgress({ progress, stage }: TranscribeProgressProps) {
  const pct = Math.max(0, Math.min(100, progress));
  return (
    <Box display="flex" flexDirection="column" gap="1">
      <HStack justifyContent="space-between" alignItems="center">
        <styled.span fontSize="xs" opacity="0.7">
          transcribing… {stage}
        </styled.span>
        <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
          {Math.round(pct)}%
        </styled.span>
      </HStack>
      <Box position="relative" height="1.5" borderRadius="full" bg="bg.muted" overflow="hidden">
        <Box
          position="absolute"
          top="0"
          left="0"
          bottom="0"
          width={`${pct}%`}
          bg="tomato.9"
          transition="width 0.2s ease"
        />
      </Box>
    </Box>
  );
}

interface OffsetControlsProps {
  offsetSec: number;
  onSetOffset: (sec: number) => void;
  onAlignToPlayhead?: () => void;
  label?: string;
}

function OffsetControls({
  offsetSec,
  onSetOffset,
  onAlignToPlayhead,
  label = "MIDI offset",
}: OffsetControlsProps) {
  // Mirror the value to a string locally so the user can clear / type a
  // sign without us snapping it back on every keystroke.
  const [text, setText] = useState(offsetSec.toFixed(2));
  useEffect(() => {
    setText(offsetSec.toFixed(2));
  }, [offsetSec]);

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw);
    const next = Number.isFinite(n) ? n : 0;
    setText(next.toFixed(2));
    if (Math.abs(next - offsetSec) > 1e-6) onSetOffset(next);
  };

  const nudge = (delta: number) => {
    const next = +(offsetSec + delta).toFixed(3);
    onSetOffset(next);
  };

  return (
    <HStack gap="2" alignItems="center" flexWrap="wrap">
      <styled.span fontSize="xs" opacity="0.7" minWidth="56px">
        {label}
      </styled.span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => nudge(-0.05)}
        aria-label="nudge offset back 50ms"
      >
        −50 ms
      </Button>
      <styled.input
        type="number"
        step="0.01"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        aria-label="midi offset seconds"
        width="72px"
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
      <Button
        size="xs"
        variant="outline"
        onClick={() => nudge(0.05)}
        aria-label="nudge offset forward 50ms"
      >
        +50 ms
      </Button>
      {onAlignToPlayhead && (
        <Button size="xs" variant="outline" onClick={onAlignToPlayhead}>
          Align to playhead
        </Button>
      )}
      {offsetSec !== 0 && (
        <Button size="xs" variant="outline" onClick={() => onSetOffset(0)}>
          Reset
        </Button>
      )}
    </HStack>
  );
}

interface AutoMatchRowProps {
  onAutoMatch: () => Promise<string | null>;
}

function AutoMatchRow({ onAutoMatch }: AutoMatchRowProps) {
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "running" } | { kind: "ok"; msg: string } | { kind: "error" }
  >({ kind: "idle" });

  const run = async () => {
    setStatus({ kind: "running" });
    const msg = await onAutoMatch();
    setStatus(msg ? { kind: "ok", msg } : { kind: "error" });
  };

  return (
    <HStack gap="2" alignItems="center" flexWrap="wrap">
      <styled.span fontSize="xs" opacity="0.7" minWidth="56px">
        Auto
      </styled.span>
      <Button size="xs" variant="outline" onClick={run} disabled={status.kind === "running"}>
        Auto-match to audio
      </Button>
      {status.kind === "running" && (
        <styled.span fontSize="xs" opacity="0.6">
          measuring…
        </styled.span>
      )}
      {status.kind === "ok" && (
        <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
          {status.msg}
        </styled.span>
      )}
      {status.kind === "error" && (
        <styled.span fontSize="xs" color="error">
          could not match — adjust manually
        </styled.span>
      )}
    </HStack>
  );
}

interface SpeedControlsProps {
  speed: number;
  onSetSpeed: (speed: number) => void;
  label?: string;
}

function SpeedControls({ speed, onSetSpeed, label = "MIDI speed" }: SpeedControlsProps) {
  // Display + edit as percent (100 = native) — easier on the ear than
  // raw multipliers — but we round to 2 decimal places under the hood.
  const [text, setText] = useState((speed * 100).toFixed(2));
  useEffect(() => {
    setText((speed * 100).toFixed(2));
  }, [speed]);

  const commit = (raw: string) => {
    const n = Number.parseFloat(raw);
    const next = Number.isFinite(n) && n > 0 ? n / 100 : 1;
    setText((next * 100).toFixed(2));
    if (Math.abs(next - speed) > 1e-6) onSetSpeed(next);
  };

  const nudge = (delta: number) => {
    const next = +(speed + delta).toFixed(4);
    onSetSpeed(next);
  };

  return (
    <HStack gap="2" alignItems="center" flexWrap="wrap">
      <styled.span fontSize="xs" opacity="0.7" minWidth="56px">
        {label}
      </styled.span>
      <Button size="xs" variant="outline" onClick={() => nudge(-0.005)} aria-label="slow midi 0.5%">
        −0.5%
      </Button>
      <styled.input
        type="number"
        step="0.01"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        aria-label="midi speed percent"
        width="84px"
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
        %
      </styled.span>
      <Button size="xs" variant="outline" onClick={() => nudge(0.005)} aria-label="fast midi 0.5%">
        +0.5%
      </Button>
      {Math.abs(speed - 1) > 1e-6 && (
        <Button size="xs" variant="outline" onClick={() => onSetSpeed(1)}>
          Reset
        </Button>
      )}
    </HStack>
  );
}

interface TrackPickerDialogProps {
  open: boolean;
  tracks: readonly MidiTrackInfo[];
  suggested: number;
  onPick: (index: number) => void;
  onCancel: () => void;
}

function TrackPickerDialog({ open, tracks, suggested, onPick, onCancel }: TrackPickerDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onCancel()} lazyMount unmountOnExit>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Title>Pick the bass track</Dialog.Title>
          <Dialog.Description>
            This MIDI has multiple tracks. Choose the one to import as the bass line — only the
            picked track is saved as bass.mid.
          </Dialog.Description>
          <VStack gap="2" alignItems="stretch" mt="3">
            {tracks.map((t) => {
              const range = t.pitchRange
                ? `${pitchName(t.pitchRange[0])}–${pitchName(t.pitchRange[1])}`
                : "empty";
              const isSuggested = t.index === suggested;
              return (
                <HStack
                  key={t.index}
                  gap="2"
                  alignItems="center"
                  justifyContent="space-between"
                  p="2"
                  borderWidth="1px"
                  borderColor={isSuggested ? "indigo.7" : "border"}
                  borderRadius="l1"
                >
                  <VStack alignItems="flex-start" gap="0">
                    <styled.span fontSize="sm" fontWeight="semibold">
                      {t.name}
                      {isSuggested && (
                        <styled.span ml="2" fontSize="xs" color="indigo.11">
                          (suggested)
                        </styled.span>
                      )}
                    </styled.span>
                    <styled.span fontSize="xs" opacity="0.6" fontVariantNumeric="tabular-nums">
                      {t.noteCount} note{t.noteCount === 1 ? "" : "s"} · {range}
                      {t.programIsBass && " · GM bass"}
                    </styled.span>
                  </VStack>
                  <Button
                    size="xs"
                    variant={isSuggested ? "solid" : "outline"}
                    onClick={() => onPick(t.index)}
                    disabled={t.noteCount === 0}
                  >
                    Use this
                  </Button>
                </HStack>
              );
            })}
            <HStack justifyContent="flex-end" mt="2">
              <Button size="sm" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </HStack>
          </VStack>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

interface LyricsPanelProps {
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  /** Current panel width in pixels (drives the parent grid column). */
  width: number;
  /** Called with the proposed new width while the user drags the handle. */
  onResize: (next: number) => void;
}

/**
 * Right-column reference panel for lyrics + chord-over-lyric text.
 * The user pastes from anywhere (Ultimate Guitar, Genius, etc.); we
 * just render it monospace and keep the source of truth in
 * `bass.tab.edits.json` so it survives reloads.
 *
 * Edit/display split keeps formatting (alignment of chords above
 * syllables) intact while reading: the textarea uses the same
 * monospace font as the display so the column widths match. A
 * drag-handle on the left edge resizes the grid column live; the
 * parent persists the chosen width to localStorage.
 */
function LyricsPanel({ value, onChange, onClose, width, onResize }: LyricsPanelProps) {
  const [editing, setEditing] = useState(value.length === 0);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    onChange(draft);
    setEditing(false);
  };

  // Drag-resize on the left edge. We capture the pointer so the drag
  // continues even when the cursor temporarily leaves the handle, and
  // we listen on window so the mouseup always fires.
  const beginResize = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      // Dragging the left edge: moving left grows the panel (cursor x
      // decreases → delta becomes positive width).
      onResize(startWidth + (startX - ev.clientX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <Box
      position="relative"
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l3"
      display="flex"
      flexDirection="column"
      gap="2"
      height="calc(100vh - 240px)"
    >
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <Box
        onMouseDown={beginResize}
        position="absolute"
        left="-3"
        top="0"
        bottom="0"
        width="2"
        cursor="ew-resize"
        bg="transparent"
        _hover={{ bg: "border" }}
        role="separator"
        aria-label="resize lyrics panel"
        aria-orientation="vertical"
      />
      <HStack justifyContent="space-between" alignItems="center">
        <styled.div fontSize="sm" fontWeight="semibold">
          Lyrics
        </styled.div>
        <HStack gap="1">
          {editing ? (
            <>
              <Button size="xs" variant="outline" onClick={() => setDraft(value)}>
                Reset
              </Button>
              <Button size="xs" onClick={commit}>
                Save
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button size="xs" variant="subtle" onClick={onClose} aria-label="hide lyrics panel">
            ✕
          </Button>
        </HStack>
      </HStack>
      {editing ? (
        <styled.textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder={
            "Paste chord-over-lyric text here.\n" +
            "Monospace font preserves chord alignment.\n\n" +
            "       C        G       Am       F\n" +
            "Hey jude, don't make it bad..."
          }
          flex="1"
          minHeight="0"
          px="2"
          py="2"
          borderWidth="1px"
          borderColor="border"
          borderRadius="l1"
          bg="canvas"
          fontFamily="mono"
          fontSize="xs"
          lineHeight="1.4"
          resize="none"
        />
      ) : (
        <styled.pre
          flex="1"
          overflow="auto"
          m="0"
          px="2"
          py="2"
          fontFamily="mono"
          fontSize="xs"
          lineHeight="1.4"
          whiteSpace="pre-wrap"
          opacity={value ? "1" : "0.5"}
        >
          {value || "(no lyrics — click Edit to paste)"}
        </styled.pre>
      )}
    </Box>
  );
}

interface SectionsListProps {
  sections: readonly SectionLabel[];
  onPlay: (idx: number) => void;
  onRemoveAt: (idx: number) => void;
  onSetRepeats: (idx: number, repeats: number) => void;
}

function SectionsList({ sections, onPlay, onRemoveAt, onSetRepeats }: SectionsListProps) {
  return (
    <Box
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l3"
      display="flex"
      flexDirection="column"
      gap="2"
    >
      <styled.div fontSize="sm" fontWeight="semibold">
        Sections
      </styled.div>
      {sections.length === 0 ? (
        <styled.span fontSize="xs" opacity="0.6">
          set A-B and click "Name section" to add one
        </styled.span>
      ) : (
        sections.map((s, idx) => (
          <HStack
            key={`${s.startSec.toFixed(3)}-${s.endSec.toFixed(3)}-${s.name}`}
            gap="2"
            alignItems="center"
            justifyContent="space-between"
          >
            <styled.span fontSize="sm" flex="1" minWidth="0">
              {s.name}
              <styled.span fontSize="xs" opacity="0.5" ml="2" fontVariantNumeric="tabular-nums">
                {fmtTime(s.startSec)}–{fmtTime(s.endSec)}
              </styled.span>
            </styled.span>
            <RepeatsInput
              value={s.repeats ?? 1}
              onChange={(v) => onSetRepeats(idx, v)}
              ariaLabel={`repeats for ${s.name}`}
            />
            <HStack gap="1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => onPlay(idx)}
                aria-label={`play ${s.name}`}
              >
                ▶
              </Button>
              <Button
                size="xs"
                variant="outline"
                colorPalette="red"
                onClick={() => onRemoveAt(idx)}
                aria-label={`delete ${s.name}`}
              >
                ✕
              </Button>
            </HStack>
          </HStack>
        ))
      )}
    </Box>
  );
}

interface RepeatsInputProps {
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}

function RepeatsInput({ value, onChange, ariaLabel }: RepeatsInputProps) {
  // Mirror the value into a string so the user can briefly clear the
  // field while typing without us snapping it back to "1" on every key.
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = Number.parseInt(raw, 10);
    const next = Number.isFinite(n) && n > 0 ? n : 1;
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <HStack gap="1" alignItems="center">
      <styled.span fontSize="xs" opacity="0.6">
        ×
      </styled.span>
      <styled.input
        type="number"
        min="1"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
        }}
        aria-label={ariaLabel}
        width="42px"
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
    </HStack>
  );
}

interface SectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, repeats?: number) => void;
}

function SectionDialog({ open, onOpenChange, onSave }: SectionDialogProps) {
  const [name, setName] = useState("");
  const [repeatsStr, setRepeatsStr] = useState("1");

  // Reset on open so previous values don't leak across sessions.
  useEffect(() => {
    if (open) {
      setName("");
      setRepeatsStr("1");
    }
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const r = Number.parseInt(repeatsStr, 10);
    onSave(trimmed, Number.isFinite(r) && r > 0 ? r : undefined);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => onOpenChange(d.open)} lazyMount unmountOnExit>
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Dialog.Title>Name section</Dialog.Title>
          <Dialog.Description>
            Region between A and B will be labelled and (optionally) marked with a repeat count.
          </Dialog.Description>
          <VStack gap="3" alignItems="stretch" mt="3">
            <styled.label fontSize="sm" display="flex" flexDirection="column" gap="1">
              Name
              <styled.input
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="Verse"
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                px="2"
                py="1"
                borderWidth="1px"
                borderColor="border"
                borderRadius="l1"
                bg="canvas"
                fontSize="sm"
              />
            </styled.label>
            <styled.label fontSize="sm" display="flex" flexDirection="column" gap="1">
              Repeats
              <styled.input
                type="number"
                min="1"
                value={repeatsStr}
                onChange={(e) => setRepeatsStr(e.currentTarget.value)}
                px="2"
                py="1"
                borderWidth="1px"
                borderColor="border"
                borderRadius="l1"
                bg="canvas"
                fontSize="sm"
                width="80px"
              />
            </styled.label>
            <HStack gap="2" justifyContent="flex-end">
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={!name.trim()}>
                Save
              </Button>
            </HStack>
          </VStack>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}
