import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, HStack, VStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import { StemEngine, STEM_NAMES, type StemBuffers, type StemName } from "@/audio/engine";
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
        if (!engineRef.current) {
          engineRef.current = new StemEngine(ctx);
        }

        const buffers = await loadStemBuffers(ctx, songId);
        if (cancelled) return;

        engineRef.current.load(buffers);
        setDuration(engineRef.current.duration);
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

  // Drive the position display while playing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const engine = engineRef.current;
      if (engine) {
        const t = engine.getCurrentTime();
        setPosition(t);
        if (t >= engine.duration) {
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
      </Slider.Root>

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
