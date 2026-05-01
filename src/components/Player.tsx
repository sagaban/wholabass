import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
// Vite ?url returns the URL of the worklet processor file so it can be
// loaded into the AudioContext via audioWorklet.addModule(). The package
// exports `./processor` as the public entry for this file.
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";
import { Box, HStack, VStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import {
  StemEngine,
  STEM_NAMES,
  type LoopRegion,
  type StemBuffers,
  type StemName,
  type StretcherNode,
} from "@/audio/engine";
import { StemMixer } from "@/components/StemMixer";
import { PianoRoll } from "@/components/PianoRoll";

type LoadStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface PlayerProps {
  songId: string;
}

export function Player({ songId }: PlayerProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<StemEngine | null>(null);
  const [load, setLoad] = useState<LoadStatus>({ kind: "loading" });
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [tempo, setTempo] = useState(1);
  const [loop, setLoopState] = useState<LoopRegion | null>(null);

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
        engine.tickLoop();
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
      setPosition(engine.getCurrentTime());
      setIsPlaying(false);
    } else {
      engine.play();
      setIsPlaying(true);
    }
  };

  const onSeek = (value: number) => {
    const engine = engineRef.current;
    if (!engine || !engine.hasBuffers) return;
    engine.seek(value);
    setPosition(engine.getCurrentTime());
  };

  const onTempo = (value: number) => {
    setTempo(value);
    engineRef.current?.setTempo(value);
  };

  const onSetA = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const a = engine.getCurrentTime();
    const existingB = loop?.b;
    // If we don't have a B yet, default to A + 4s (clamped to duration).
    const b = existingB && existingB > a ? existingB : Math.min(a + 4, engine.duration);
    if (b <= a) return;
    engine.setLoop({ a, b });
    setLoopState(engine.getLoop());
  };

  const onSetB = () => {
    const engine = engineRef.current;
    if (!engine) return;
    const b = engine.getCurrentTime();
    const existingA = loop?.a;
    const a = existingA !== undefined && existingA < b ? existingA : Math.max(0, b - 4);
    if (b <= a) return;
    engine.setLoop({ a, b });
    setLoopState(engine.getLoop());
  };

  const onClearLoop = () => {
    engineRef.current?.clearLoop();
    setLoopState(null);
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
    <VStack mt="5" gap="3" alignItems="stretch" width="min(540px, 100%)">
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
        {loop && (
          <Slider.Marks
            marks={[
              { value: loop.a, label: "A" },
              { value: loop.b, label: "B" },
            ]}
          />
        )}
      </Slider.Root>

      <HStack gap="2" alignItems="center" justifyContent="space-between">
        <HStack gap="2" alignItems="center">
          <Button size="xs" variant="outline" onClick={onSetA}>
            Set A
          </Button>
          <Button size="xs" variant="outline" onClick={onSetB}>
            Set B
          </Button>
          <Button size="xs" variant="outline" onClick={onClearLoop} disabled={!loop}>
            Clear A-B
          </Button>
        </HStack>
        <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
          {loop ? `Loop ${fmtTime(loop.a)} → ${fmtTime(loop.b)}` : "no loop"}
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

      {engineRef.current && <PianoRoll songId={songId} engine={engineRef.current} />}
      {engineRef.current && <StemMixer engine={engineRef.current} />}
    </VStack>
  );
}

async function loadStemBuffers(ctx: AudioContext, songId: string): Promise<StemBuffers> {
  const entries = await Promise.all(
    STEM_NAMES.map(async (stem) => [stem, await loadStem(ctx, songId, stem)] as const),
  );
  const out = {} as StemBuffers;
  for (const [name, buf] of entries) {
    out[name] = buf;
  }
  return out;
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
