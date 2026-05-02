import { useEffect, useState } from "react";
import { Box, Divider, Grid, HStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import { STEM_NAMES, type StemEngine, type StemName } from "@/audio/engine";
import { type MidiSynth } from "@/audio/midi-synth";

interface StemMixerProps {
  engine: StemEngine;
  synth: MidiSynth;
}

interface StripState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}

type Track = StemName | "midi";
const TRACKS: readonly Track[] = [...STEM_NAMES, "midi"] as const;

const INITIAL_STEM_STRIP: StripState = { volume: 1, muted: false, soloed: false };
// MIDI is silent by default — user opts in via volume or solo.
const INITIAL_MIDI_STRIP: StripState = { volume: 0, muted: false, soloed: false };
const STRIP_GRID_COLS = "70px 1fr 36px 70px";

function effectiveTrackGain(strip: StripState, anySoloed: boolean): number {
  if (strip.muted) return 0;
  if (anySoloed && !strip.soloed) return 0;
  return Math.max(0, Math.min(1, strip.volume));
}

export function StemMixer({ engine, synth }: StemMixerProps) {
  const [strips, setStrips] = useState<Record<Track, StripState>>({
    vocals: INITIAL_STEM_STRIP,
    drums: INITIAL_STEM_STRIP,
    bass: INITIAL_STEM_STRIP,
    other: INITIAL_STEM_STRIP,
    midi: INITIAL_MIDI_STRIP,
  });
  const [master, setMaster] = useState(1);

  // The mixer owns the gating logic so solo semantics stretch across stems
  // + the synth uniformly. We push the resulting per-track gain to the
  // engine via setVolume (skipping its own muted/soloed bookkeeping) and
  // to the synth via setMasterVolume.
  useEffect(() => {
    const anySoloed = TRACKS.some((t) => strips[t].soloed);
    for (const stem of STEM_NAMES) {
      engine.setVolume(stem, effectiveTrackGain(strips[stem], anySoloed));
    }
    synth.setMasterVolume(effectiveTrackGain(strips.midi, anySoloed));
  }, [strips, engine, synth]);

  const update = (track: Track, patch: Partial<StripState>) => {
    setStrips((s) => ({ ...s, [track]: { ...s[track], ...patch } }));
  };

  const onVolumeChange = (track: Track, value: number) => {
    update(track, { volume: value });
  };

  const onToggleMute = (track: Track) => {
    update(track, { muted: !strips[track].muted });
  };

  const onToggleSolo = (track: Track) => {
    update(track, { soloed: !strips[track].soloed });
  };

  const onMasterChange = (value: number) => {
    setMaster(value);
    engine.setMasterVolume(value);
  };

  return (
    <Box
      mt="3"
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l3"
      display="flex"
      flexDirection="column"
      gap="2"
      width="min(540px, 100%)"
    >
      <MasterStrip value={master} onChange={onMasterChange} />
      <Divider color="border" />
      {TRACKS.map((track) => (
        <Strip
          key={track}
          track={track}
          state={strips[track]}
          onVolumeChange={(v) => onVolumeChange(track, v)}
          onToggleMute={() => onToggleMute(track)}
          onToggleSolo={() => onToggleSolo(track)}
        />
      ))}
    </Box>
  );
}

function MasterStrip({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Grid gridTemplateColumns={STRIP_GRID_COLS} alignItems="center" gap="2">
      <styled.div fontSize="sm" fontWeight="semibold">
        Master
      </styled.div>
      <Slider.Root
        value={[value]}
        onValueChange={(d) => onChange(d.value[0] ?? 0)}
        min={0}
        max={1}
        step={0.01}
        aria-label={["master volume"]}
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
      <ValueReadout>{Math.round(value * 100)}</ValueReadout>
      <Box />
    </Grid>
  );
}

interface StripProps {
  track: Track;
  state: StripState;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}

function Strip({ track, state, onVolumeChange, onToggleMute, onToggleSolo }: StripProps) {
  const label = track === "midi" ? "MIDI" : track;
  return (
    <Grid gridTemplateColumns={STRIP_GRID_COLS} alignItems="center" gap="2">
      <styled.div fontSize="sm" textTransform={track === "midi" ? "none" : "capitalize"}>
        {label}
      </styled.div>

      <Slider.Root
        value={[state.volume]}
        onValueChange={(d) => onVolumeChange(d.value[0] ?? 0)}
        min={0}
        max={1}
        step={0.01}
        aria-label={[`${track} volume`]}
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

      <ValueReadout>{Math.round(state.volume * 100)}</ValueReadout>

      <HStack gap="1" justifyContent="flex-end">
        <Button
          size="xs"
          variant={state.muted ? "solid" : "outline"}
          onClick={onToggleMute}
          aria-pressed={state.muted}
          aria-label={`mute ${track}`}
        >
          M
        </Button>
        <Button
          size="xs"
          variant={state.soloed ? "solid" : "outline"}
          onClick={onToggleSolo}
          aria-pressed={state.soloed}
          aria-label={`solo ${track}`}
        >
          S
        </Button>
      </HStack>
    </Grid>
  );
}

function ValueReadout({ children }: { children: React.ReactNode }) {
  return (
    <styled.div fontVariantNumeric="tabular-nums" fontSize="xs" opacity="0.7" textAlign="right">
      {children}
    </styled.div>
  );
}
