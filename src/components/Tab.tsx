import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, styled } from "styled-system/jsx";
import { type StemEngine } from "@/audio/engine";
import { loadBassNotes, type BassNote } from "@/audio/midi";
import {
  barLineTimes,
  DEFAULT_LAYOUT,
  stringIndexToY,
  timeToX,
  totalHeight,
  totalWidth,
} from "@/tab/render";
import { fingerNotes, type TabNote } from "@/tab/optimizer";

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

export function Tab({ songId, engine, durationSec }: TabProps) {
  const [tabNotes, setTabNotes] = useState<TabNote[]>([]);
  const [beats, setBeats] = useState<BeatsPayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");

  // Fetch MIDI + beats whenever the song changes; run the optimizer.
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
        setTabNotes(fingerNotes(notes as readonly BassNote[]));
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
    <TabSurface tabNotes={tabNotes} beats={beats!} engine={engine} durationSec={durationSec} />
  );
}

interface TabSurfaceProps {
  tabNotes: TabNote[];
  beats: BeatsPayload;
  engine: StemEngine;
  durationSec: number;
}

const STRING_LABELS = ["E", "A", "D", "G"] as const;

function TabSurface({ tabNotes, beats, engine, durationSec }: TabSurfaceProps) {
  const layout = DEFAULT_LAYOUT;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<SVGLineElement | null>(null);

  const width = totalWidth(durationSec, layout);
  const height = totalHeight(layout);
  const bars = useMemo(
    () => barLineTimes(beats.beats, layout.beatsPerBar),
    [beats.beats, layout.beatsPerBar],
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
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        overflowX="auto"
        overflowY="hidden"
        bg="canvas"
        height={`${height + 4}px`}
      >
        <styled.svg width={width} height={height} display="block" fontFamily="inherit">
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

          {/* Notes */}
          {tabNotes.map((n) => {
            const x = timeToX(n.startSec, layout);
            const y = stringIndexToY(n.string, layout);
            const key = `${n.startSec.toFixed(4)}-${n.pitch}-${n.string}-${n.fret}`;
            return (
              <g key={key}>
                {/* tiny background so the fret number is readable on the line */}
                <rect
                  x={x - 7}
                  y={y - 8}
                  width={14}
                  height={16}
                  rx={3}
                  fill="var(--colors-canvas)"
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
        </styled.svg>
      </Box>
    </Box>
  );
}
