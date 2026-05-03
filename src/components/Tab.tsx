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
  applyEdits,
  tabNoteId,
  type EditOp,
  type EditsFile,
  type NoteId,
  type SectionLabel,
} from "@/tab/edits";
import { beatIndexAt, localBeatDuration } from "@/tab/rhythm";

interface TabProps {
  songId: string;
  engine: StemEngine;
  durationSec: number;
  edits: EditsFile;
  onEdit: (op: EditOp) => void;
  onRemoveSectionAt: (index: number) => void;
}

interface BeatsPayload {
  tempo_bpm: number;
  beats: number[];
}

type LoadStatus = "loading" | "ready" | { kind: "error"; message: string };

export function Tab({ songId, engine, durationSec, edits, onEdit, onRemoveSectionAt }: TabProps) {
  const [optimizerNotes, setOptimizerNotes] = useState<TabNote[]>([]);
  const [beats, setBeats] = useState<BeatsPayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        const [notes, b] = await Promise.all([
          loadBassNotes(songId),
          invoke<BeatsPayload>("read_beats", { songId }),
        ]);
        if (cancelled) return;
        setOptimizerNotes(fingerNotes(notes as readonly BassNote[]));
        setBeats(b);
        setStatus("ready");
      } catch (err: unknown) {
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId]);

  const displayNotes = useMemo(() => applyEdits(optimizerNotes, edits), [optimizerNotes, edits]);

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
      sections={edits.sections}
      onEdit={onEdit}
      onRemoveSectionAt={onRemoveSectionAt}
    />
  );
}

interface TabSurfaceProps {
  tabNotes: TabNote[];
  beats: BeatsPayload;
  engine: StemEngine;
  durationSec: number;
  sections: readonly SectionLabel[];
  onEdit: (op: EditOp) => void;
  onRemoveSectionAt: (index: number) => void;
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
  onEdit,
  onRemoveSectionAt,
}: TabSurfaceProps) {
  const layout = DEFAULT_LAYOUT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
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

  const [addTarget, setAddTarget] = useState<AddNoteTarget | null>(null);
  const closeAdd = useCallback(() => setAddTarget(null), []);
  const [selectedSectionIdx, setSelectedSectionIdx] = useState<number | null>(null);
  const closeSection = useCallback(() => setSelectedSectionIdx(null), []);

  const handleStaffClick = useCallback(
    (e: React.MouseEvent<SVGElement>) => {
      // Only fire when the user clicked the SVG background (or a non-note
      // child like a string line). Note groups stopPropagation already.
      if (e.defaultPrevented) return;
      const svg = svgRef.current;
      if (!svg) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const screenCTM = svg.getScreenCTM();
      if (!screenCTM) return;
      const local = pt.matrixTransform(screenCTM.inverse());
      // Reject clicks above the staff (where bar numbers + sections live).
      if (local.y < layout.topPadding - 6) return;
      const stringIdx = closestString(local.y, layout);
      const startSec = snapToSixteenth(local.x / layout.pixelsPerSecond, beats.beats);
      setAddTarget({
        startSec,
        string: stringIdx,
        x: timeToX(startSec, layout),
        y: stringIndexToY(stringIdx, layout),
      });
    },
    [beats.beats, layout],
  );

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
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events */}
        <svg
          ref={svgRef}
          width={width}
          height={height}
          role="application"
          aria-label="bass tab editor"
          onClick={handleStaffClick}
          className={css({ display: "block", fontFamily: "inherit" })}
        >
          {/* Section bands above the staff */}
          {sections.map((section, idx) => {
            const x1 = timeToX(section.startSec, layout);
            const x2 = timeToX(section.endSec, layout);
            const isSelected = selectedSectionIdx === idx;
            const labelText =
              section.repeats && section.repeats > 1
                ? `${section.name} ×${section.repeats}`
                : section.name;
            return (
              <g
                key={`section-${section.startSec.toFixed(3)}-${section.endSec.toFixed(3)}-${section.name}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  ev.preventDefault();
                  setSelectedSectionIdx(idx);
                }}
                className={css({ cursor: "pointer" })}
              >
                <rect
                  x={x1}
                  y={2}
                  width={Math.max(2, x2 - x1)}
                  height={SECTION_BAND_HEIGHT_PX}
                  rx={2}
                  fill={isSelected ? "var(--colors-indigo-4)" : "var(--colors-indigo-3)"}
                  stroke="var(--colors-indigo-7)"
                  strokeWidth={1}
                />
                <text
                  x={x1 + 5}
                  y={SECTION_BAND_HEIGHT_PX - 3}
                  fontSize="11"
                  fontWeight="600"
                  fill="var(--colors-indigo-11)"
                >
                  {labelText}
                </text>
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

        {addTarget && (
          <AddNotePopover
            target={addTarget}
            durationSec={localBeatDuration(addTarget.startSec, beats.beats)}
            onAdd={(string, fret) => {
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
            onClose={closeAdd}
          />
        )}

        {selectedSectionIdx !== null && sections[selectedSectionIdx] && (
          <SectionDeletePopover
            section={sections[selectedSectionIdx]}
            anchorX={timeToX(sections[selectedSectionIdx].startSec, layout)}
            anchorY={2}
            onDelete={() => {
              onRemoveSectionAt(selectedSectionIdx);
              closeSection();
            }}
            onClose={closeSection}
          />
        )}
      </Box>
    </Box>
  );
}

interface AddNotePopoverProps {
  target: AddNoteTarget;
  durationSec: number;
  onAdd: (string: number, fret: number) => void;
  onClose: () => void;
}

function AddNotePopover({ target, onAdd, onClose }: AddNotePopoverProps) {
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
              <HStack gap="1" flexWrap="wrap">
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
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

interface SectionDeletePopoverProps {
  section: SectionLabel;
  anchorX: number;
  anchorY: number;
  onDelete: () => void;
  onClose: () => void;
}

function SectionDeletePopover({
  section,
  anchorX,
  anchorY,
  onDelete,
  onClose,
}: SectionDeletePopoverProps) {
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
              <styled.span fontSize="xs" opacity="0.7">
                {section.name}
                {section.repeats && section.repeats > 1 ? ` ×${section.repeats}` : ""}
              </styled.span>
            </Popover.Title>
            <Popover.Body>
              <Button size="xs" variant="outline" colorPalette="red" onClick={onDelete}>
                Delete section
              </Button>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

interface NoteEditPopoverProps {
  note: TabNote;
  anchorX: number;
  anchorY: number;
  onEdit: (op: EditOp) => void;
  onClose: () => void;
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

function NoteEditPopover({ note, anchorX, anchorY, onEdit, onClose }: NoteEditPopoverProps) {
  const id = tabNoteId(note);
  const placements = useMemo(() => enumeratePlacements(note.pitch, DEFAULT_TUNING), [note.pitch]);
  const octaveUp = useMemo(() => bestOctavePlacement(note.pitch + 12), [note.pitch]);
  const octaveDown = useMemo(() => bestOctavePlacement(note.pitch - 12), [note.pitch]);
  const noAlternates = placements.length === 0;

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
