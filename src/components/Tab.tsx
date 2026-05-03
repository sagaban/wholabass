import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, HStack, styled } from "styled-system/jsx";
import { css } from "styled-system/css";
import { type StemEngine } from "@/audio/engine";
import { loadBassNotes, type BassNote } from "@/audio/midi";
import { Portal } from "@ark-ui/react/portal";
import { Button, Popover } from "@/components/ui";
import {
  barLineTimes,
  DEFAULT_LAYOUT,
  stringIndexToY,
  timeToX,
  totalHeight,
  totalWidth,
} from "@/tab/render";
import { DEFAULT_TUNING, enumeratePlacements, fingerNotes, type TabNote } from "@/tab/optimizer";
import { beamGroups, classifyNote, rhythmGlyph } from "@/tab/rhythm";
import {
  EMPTY_EDITS,
  applyEdits,
  tabNoteId,
  upsertEdit,
  type EditOp,
  type EditsFile,
  type NoteId,
} from "@/tab/edits";

interface TabProps {
  songId: string;
  engine: StemEngine;
  durationSec: number;
}

interface BeatsPayload {
  tempo_bpm: number;
  beats: number[];
}

type LoadStatus = "loading" | "ready" | { kind: "error"; message: string };

const AUTOSAVE_DELAY_MS = 500;

export function Tab({ songId, engine, durationSec }: TabProps) {
  const [optimizerNotes, setOptimizerNotes] = useState<TabNote[]>([]);
  const [beats, setBeats] = useState<BeatsPayload | null>(null);
  const [edits, setEdits] = useState<EditsFile>(EMPTY_EDITS);
  const [status, setStatus] = useState<LoadStatus>("loading");
  // Skip the autosave when edits are first hydrated from disk — only
  // user mutations should trigger a write.
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    dirtyRef.current = false;
    void (async () => {
      try {
        const [notes, b, e] = await Promise.all([
          loadBassNotes(songId),
          invoke<BeatsPayload>("read_beats", { songId }),
          invoke<EditsFile>("read_edits", { songId }),
        ]);
        if (cancelled) return;
        setOptimizerNotes(fingerNotes(notes as readonly BassNote[]));
        setBeats(b);
        setEdits(normalizeEdits(e));
        setStatus("ready");
      } catch (err: unknown) {
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  // Debounced autosave: every mutation schedules a write, replacing any
  // pending one. On unmount or song-change we flush immediately so a
  // quick edit + close doesn't lose the change.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = setTimeout(() => {
      void invoke("write_edits", { songId, edits });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [edits, songId]);

  const displayNotes = useMemo(() => applyEdits(optimizerNotes, edits), [optimizerNotes, edits]);

  const handleEdit = useCallback((op: EditOp) => {
    dirtyRef.current = true;
    setEdits((prev) => ({ ...prev, notes: upsertEdit(prev.notes, op) }));
  }, []);

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
      beats={beats!}
      engine={engine}
      durationSec={durationSec}
      onEdit={handleEdit}
    />
  );
}

function normalizeEdits(raw: unknown): EditsFile {
  if (!raw || typeof raw !== "object") return EMPTY_EDITS;
  const r = raw as Partial<EditsFile>;
  return {
    version: typeof r.version === "number" ? r.version : EMPTY_EDITS.version,
    notes: Array.isArray(r.notes) ? (r.notes as EditOp[]) : [],
    sections: Array.isArray(r.sections) ? r.sections : [],
  };
}

interface TabSurfaceProps {
  tabNotes: TabNote[];
  beats: BeatsPayload;
  engine: StemEngine;
  durationSec: number;
  onEdit: (op: EditOp) => void;
}

const STRING_LABELS = ["E", "A", "D", "G"] as const;
const STEM_LENGTH_PX = 14;
const FLAG_LENGTH_PX = 5;
const FLAG_GAP_PX = 3;

function TabSurface({ tabNotes, beats, engine, durationSec, onEdit }: TabSurfaceProps) {
  const layout = DEFAULT_LAYOUT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<SVGLineElement | null>(null);

  const width = totalWidth(durationSec, layout);
  const height = totalHeight(layout);
  const bars = useMemo(
    () => barLineTimes(beats.beats, layout.beatsPerBar),
    [beats.beats, layout.beatsPerBar],
  );
  const groups = useMemo(() => beamGroups(tabNotes, beats.beats), [tabNotes, beats.beats]);

  const [selectedId, setSelectedId] = useState<NoteId | null>(null);
  const selectedNote = useMemo(
    () => (selectedId ? (tabNotes.find((n) => tabNoteId(n) === selectedId) ?? null) : null),
    [selectedId, tabNotes],
  );
  const closePopover = useCallback(() => setSelectedId(null), []);

  // rAF loop: move the playhead and keep it visible.
  // While playing → hold the playhead at ~25% from the viewport's left edge.
  // While paused → only nudge if the user seeked the playhead off-screen,
  // so manual scrolling for inspection isn't fought by the loop.
  useEffect(() => {
    let raf = 0;
    const margin = 60;
    const tick = () => {
      const t = engine.getCurrentTime();
      const x = timeToX(t, layout);
      const playhead = playheadRef.current;
      if (playhead) {
        playhead.setAttribute("x1", String(x));
        playhead.setAttribute("x2", String(x));
      }
      const scroller = scrollRef.current;
      if (scroller) {
        const viewport = scroller.clientWidth;
        const offsetInView = x - scroller.scrollLeft;
        const offscreen = offsetInView < margin || offsetInView > viewport - margin;
        if (engine.isPlaying || offscreen) {
          const target = Math.max(0, x - viewport * 0.25);
          if (Math.abs(scroller.scrollLeft - target) > 4) {
            scroller.scrollLeft = target;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine, layout]);

  return (
    <Box mt="3">
      <Box as="div" fontSize="xs" opacity="0.7" mb="1" fontVariantNumeric="tabular-nums">
        ♩ = {Math.round(beats.tempo_bpm)} · {bars.length} bars · {tabNotes.length} notes
      </Box>
      <Box
        ref={scrollRef}
        position="relative"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        overflowX="auto"
        overflowY="hidden"
        bg="canvas"
        height={`${height + 4}px`}
      >
        <svg
          width={width}
          height={height}
          className={css({ display: "block", fontFamily: "inherit" })}
        >
          {/* String lines */}
          {STRING_LABELS.map((label, i) => {
            const y = stringIndexToY(i, layout);
            return (
              <line
                key={`str-${label}`}
                x1={0}
                x2={width}
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

          {/* Bar lines + bar numbers */}
          {bars.map((t, idx) => {
            const x = timeToX(t, layout);
            return (
              <g key={`bar-${t.toFixed(4)}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={layout.topPadding - 4}
                  y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing + 4}
                  stroke="var(--colors-border)"
                  strokeWidth={idx === 0 ? 2 : 1}
                />
                <text
                  x={x + 3}
                  y={layout.topPadding - 8}
                  fontSize="10"
                  fill="var(--colors-fg-muted)"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {idx + 1}
                </text>
              </g>
            );
          })}

          {/* Fret numbers — click to edit */}
          {tabNotes.map((n) => {
            const x = timeToX(n.startSec, layout);
            const y = stringIndexToY(n.string, layout);
            const glyph = rhythmGlyph(classifyNote(n, beats.beats));
            const id = tabNoteId(n);
            const isSelected = id === selectedId;
            return (
              <g
                key={id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setSelectedId(id);
                }}
                className={css({ cursor: "pointer" })}
              >
                {/* tiny background so the fret number is readable on the line */}
                <rect
                  x={x - 7}
                  y={y - 8}
                  width={14}
                  height={16}
                  rx={3}
                  fill={isSelected ? "var(--colors-indigo-3)" : "var(--colors-canvas)"}
                />
                <text
                  x={x}
                  y={y + 4}
                  fontSize="12"
                  textAnchor="middle"
                  fontWeight="600"
                  fill="var(--colors-indigo-11)"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {n.fret}
                </text>
                {glyph.dotted && (
                  <circle cx={x + 8} cy={y + 1} r={1.4} fill="var(--colors-indigo-11)" />
                )}
              </g>
            );
          })}

          {/* Rhythm: stems + beams (groups of ≥ 2) or flags (singletons) */}
          {groups.map((g) => {
            if (g.beamLevels === 0) return null;
            const stemTop = stringIndexToY(0, layout) + 2;
            const stemBottom = stringIndexToY(0, layout) + STEM_LENGTH_PX;
            const xs = g.indices.map((i) => timeToX(tabNotes[i].startSec, layout));
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
                  ? // Beam: one horizontal bar per beam level, stacked.
                    Array.from({ length: g.beamLevels }, (_, b) => {
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
                  : // Singleton short note: short flag pointing right.
                    Array.from({ length: g.beamLevels }, (_, b) => {
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

          {/* Playhead */}
          <line
            ref={playheadRef}
            x1={0}
            x2={0}
            y1={layout.topPadding - 8}
            y2={layout.topPadding + (layout.stringCount - 1) * layout.stringLineSpacing + 8}
            stroke="var(--colors-indigo-9)"
            strokeWidth={2}
          />
        </svg>

        {selectedNote && (
          <NoteEditPopover
            note={selectedNote}
            anchorX={timeToX(selectedNote.startSec, layout)}
            anchorY={stringIndexToY(selectedNote.string, layout)}
            onEdit={onEdit}
            onClose={closePopover}
          />
        )}
      </Box>
    </Box>
  );
}

interface NoteEditPopoverProps {
  note: TabNote;
  anchorX: number;
  anchorY: number;
  onEdit: (op: EditOp) => void;
  onClose: () => void;
}

function NoteEditPopover({ note, anchorX, anchorY, onEdit, onClose }: NoteEditPopoverProps) {
  const id = tabNoteId(note);
  const placements = useMemo(
    () => enumeratePlacements(note.pitch, DEFAULT_TUNING, 12),
    [note.pitch],
  );
  const octaveUp = useMemo(
    () => enumeratePlacements(note.pitch + 12, DEFAULT_TUNING, 12)[0] ?? null,
    [note.pitch],
  );
  const octaveDown = useMemo(
    () => enumeratePlacements(note.pitch - 12, DEFAULT_TUNING, 12)[0] ?? null,
    [note.pitch],
  );

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
                pitch {note.pitch} · current {STRING_LABELS[note.string]}
                {note.fret}
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <styled.div fontSize="xs" opacity="0.7" mb="1">
                alternates
              </styled.div>
              <HStack gap="1" flexWrap="wrap" mb="3">
                {placements.length === 0 ? (
                  <styled.span fontSize="xs" opacity="0.5">
                    none in range
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
