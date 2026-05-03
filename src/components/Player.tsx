import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { loadBassNotes, type BassNote } from "@/audio/midi";
import { MidiSynth } from "@/audio/midi-synth";
import { StemMixer } from "@/components/StemMixer";
import { PianoRoll } from "@/components/PianoRoll";
import { Tab } from "@/components/Tab";
import {
  EMPTY_EDITS,
  addSection,
  removeSectionAt,
  upsertEdit,
  type EditOp,
  type EditsFile,
} from "@/tab/edits";

type LoadStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface PlayerProps {
  songId: string;
}

function normalizeEditsFile(raw: unknown): EditsFile {
  if (!raw || typeof raw !== "object") return EMPTY_EDITS;
  const r = raw as Partial<EditsFile>;
  return {
    version: typeof r.version === "number" ? r.version : EMPTY_EDITS.version,
    notes: Array.isArray(r.notes) ? (r.notes as EditOp[]) : [],
    sections: Array.isArray(r.sections) ? r.sections : [],
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
  const [edits, setEdits] = useState<EditsFile>(EMPTY_EDITS);
  const editsDirtyRef = useRef(false);
  const [sectionDialogOpen, setSectionDialogOpen] = useState(false);

  const onEdit = useCallback((op: EditOp) => {
    editsDirtyRef.current = true;
    setEdits((prev) => ({ ...prev, notes: upsertEdit(prev.notes, op) }));
  }, []);

  const onAddSection = useCallback(
    (name: string, repeats?: number) => {
      if (markA === null || markB === null || markB <= markA) return;
      editsDirtyRef.current = true;
      setEdits((prev) => ({
        ...prev,
        sections: addSection(prev.sections, {
          startSec: markA,
          endSec: markB,
          name,
          repeats: repeats && repeats > 1 ? repeats : undefined,
        }),
      }));
    },
    [markA, markB],
  );

  const onRemoveSectionAt = useCallback((index: number) => {
    editsDirtyRef.current = true;
    setEdits((prev) => ({ ...prev, sections: removeSectionAt(prev.sections, index) }));
  }, []);

  // Load + autosave the edits overlay alongside stems.
  useEffect(() => {
    let cancelled = false;
    editsDirtyRef.current = false;
    void (async () => {
      try {
        const raw = await invoke<unknown>("read_edits", { songId });
        if (cancelled) return;
        setEdits(normalizeEditsFile(raw));
      } catch {
        if (!cancelled) setEdits(EMPTY_EDITS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  useEffect(() => {
    if (!editsDirtyRef.current) return;
    const timer = setTimeout(() => {
      void invoke("write_edits", { songId, edits });
    }, 500);
    return () => clearTimeout(timer);
  }, [edits, songId]);

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

        const [buffers, notes] = await Promise.all([
          loadStemBuffers(ctx, songId),
          loadBassNotes(songId).catch(() => [] as BassNote[]),
        ]);
        if (cancelled) return;

        const engine = engineRef.current;
        engine.load(buffers);
        bassNotesRef.current = notes;
        synthRef.current.setNotes(notes);
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
        }
        const t = engine.getCurrentTime();
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

  const onTogglePlay = () => {
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
  };

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
    setMarkA(null);
    setMarkB(null);
  };

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
      gridTemplateColumns={{ base: "1fr", lg: "minmax(320px, 380px) 1fr" }}
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

          <HStack gap="2" alignItems="center" justifyContent="space-between" flexWrap="wrap">
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

          {engineRef.current && synthRef.current && (
            <StemMixer engine={engineRef.current} synth={synthRef.current} />
          )}

          <HStack justifyContent="flex-end">
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
            engine={engineRef.current}
            durationSec={duration}
            edits={edits}
            onEdit={onEdit}
            onRemoveSectionAt={onRemoveSectionAt}
          />
        )}
      </GridItem>

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
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
