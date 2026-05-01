import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, HStack, VStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import { StemEngine, STEM_NAMES, type StemName, type StemUrls } from "@/audio/engine";
import { StemMixer } from "@/components/StemMixer";
import { PianoRoll } from "@/components/PianoRoll";

type LoadStatus = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

interface PlayerProps {
  songId: string;
}

export function Player({ songId }: PlayerProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const engineRef = useRef<StemEngine | null>(null);
  const urlsRef = useRef<string[]>([]);
  const [load, setLoad] = useState<LoadStatus>({ kind: "loading" });
  const [position, setPosition] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [tempo, setTempo] = useState(1);

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

        const urls = await loadStemUrls(songId);
        if (cancelled) {
          revokeUrls(Object.values(urls));
          return;
        }

        // Free the previous song's blob URLs.
        revokeUrls(urlsRef.current);
        urlsRef.current = Object.values(urls);

        const engine = engineRef.current;
        engine.load(urls);

        // HTMLAudioElement reports `duration` only after metadata loads.
        await waitForDuration(urls.vocals);
        if (cancelled) return;
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

  // Free blob URLs on unmount.
  useEffect(() => {
    return () => {
      revokeUrls(urlsRef.current);
      urlsRef.current = [];
    };
  }, []);

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
      void engine.play();
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

async function loadStemUrls(songId: string): Promise<StemUrls> {
  const entries = await Promise.all(
    STEM_NAMES.map(async (stem) => [stem, await loadStemUrl(songId, stem)] as const),
  );
  const out = {} as StemUrls;
  for (const [name, url] of entries) {
    out[name] = url;
  }
  return out;
}

async function loadStemUrl(songId: string, stem: StemName): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_stem", { songId, stem });
  const blob = new Blob([bytes], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

function revokeUrls(urls: string[]): void {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // already gone
    }
  }
}

async function waitForDuration(url: string): Promise<void> {
  // Probe the metadata so engine.duration is non-zero before we hand control
  // to the UI. The actual <audio> elements inside the engine will load on
  // their own; this is just a one-off probe.
  await new Promise<void>((resolve, reject) => {
    const probe = new Audio();
    const cleanup = () => {
      probe.removeEventListener("loadedmetadata", onLoaded);
      probe.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("failed to load audio metadata"));
    };
    probe.addEventListener("loadedmetadata", onLoaded);
    probe.addEventListener("error", onError);
    probe.preload = "metadata";
    probe.src = url;
  });
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
