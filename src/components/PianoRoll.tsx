import { useEffect, useRef, useState } from "react";
import { Box, styled } from "styled-system/jsx";
import { token, type Token } from "styled-system/tokens";
import { loadBassNotes, type BassNote } from "@/audio/midi";
import type { StemEngine } from "@/audio/engine";

interface PianoRollProps {
  songId: string;
  engine: StemEngine;
}

/** Bass range used for the vertical axis. E1 .. G4 (≈ 4-string 24-fret). */
const PITCH_LO = 28; // E1
const PITCH_HI = 67; // G4
/** Visible window around the playhead, in seconds. */
const WINDOW_SEC = 8;
const PLAYHEAD_FRACTION = 0.25; // playhead sits 25% from the left edge

export function PianoRoll({ songId, engine }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const notesRef = useRef<BassNote[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | { kind: "error"; message: string }>(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadBassNotes(songId)
      .then((notes) => {
        if (cancelled) return;
        notesRef.current = notes;
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [songId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || status !== "ready") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const colors = readColors();

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      const pxWidth = Math.floor(cssWidth * dpr);
      const pxHeight = Math.floor(cssHeight * dpr);
      if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
        canvas.width = pxWidth;
        canvas.height = pxHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const now = engine.getCurrentTime();
      const windowStart = now - WINDOW_SEC * PLAYHEAD_FRACTION;
      const windowEnd = windowStart + WINDOW_SEC;
      const xPerSec = cssWidth / WINDOW_SEC;
      const pitchSpan = PITCH_HI - PITCH_LO + 1;
      const rowH = cssHeight / pitchSpan;

      // Background.
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      // Horizontal pitch grid (octaves emphasised).
      ctx.strokeStyle = colors.gridSubtle;
      ctx.lineWidth = 1;
      for (let p = PITCH_LO; p <= PITCH_HI; p++) {
        const y = (PITCH_HI - p + 0.5) * rowH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssWidth, y);
        ctx.strokeStyle = p % 12 === 0 ? colors.gridStrong : colors.gridSubtle;
        ctx.stroke();
      }

      // Notes.
      ctx.fillStyle = colors.note;
      for (const n of notesRef.current) {
        if (n.startSec + n.durSec < windowStart) continue;
        if (n.startSec > windowEnd) break;
        if (n.pitch < PITCH_LO || n.pitch > PITCH_HI) continue;
        const x = (n.startSec - windowStart) * xPerSec;
        const w = Math.max(2, n.durSec * xPerSec);
        const y = (PITCH_HI - n.pitch) * rowH;
        const h = Math.max(2, rowH - 1);
        ctx.fillStyle = colors.note;
        ctx.globalAlpha = 0.5 + 0.5 * Math.min(1, n.velocity);
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }

      // Playhead.
      const playX = WINDOW_SEC * PLAYHEAD_FRACTION * xPerSec;
      ctx.strokeStyle = colors.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, cssHeight);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status, engine]);

  if (status === "loading") {
    return (
      <Box mt="3" opacity="0.7" fontSize="sm">
        loading bass MIDI…
      </Box>
    );
  }
  if (typeof status === "object") {
    return (
      <Box mt="3" color="error" fontSize="sm">
        midi load error: {status.message}
      </Box>
    );
  }

  return (
    <Box
      mt="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      overflow="hidden"
      width="min(540px, 100%)"
      height="180px"
    >
      <styled.canvas
        ref={canvasRef}
        display="block"
        width="full"
        height="full"
        // Canvas internal pixel buffer is set via JS; CSS just sizes the box.
        style={{ width: "100%", height: "100%" }}
      />
    </Box>
  );
}

interface RollColors {
  bg: string;
  gridSubtle: string;
  gridStrong: string;
  note: string;
  playhead: string;
}

function readColors(): RollColors {
  // Panda's token.var(path) returns the full `var(--name)` expression.
  // Canvas's fillStyle/strokeStyle don't resolve CSS variables, so we strip
  // out the inner property name and read its current value off :root.
  const cs = getComputedStyle(document.documentElement);
  const resolve = (path: Token, fallback: string): string => {
    const expr = token.var(path); // "var(--colors-...)"
    const m = /^var\((--[^,)]+)\)$/.exec(expr);
    if (!m) return fallback;
    return cs.getPropertyValue(m[1]).trim() || fallback;
  };
  return {
    bg: resolve("colors.canvas", "#0c0c10"),
    gridSubtle: resolve("colors.gray.4", "#272a2d"),
    gridStrong: resolve("colors.gray.6", "#363a3f"),
    note: resolve("colors.indigo.9", "#3e63dd"),
    playhead: resolve("colors.indigo.11", "#9eb1ff"),
  };
}
