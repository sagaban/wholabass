import { useCallback, useEffect, useState } from "react";
import { Box, Divider, Grid, HStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import { STEM_NAMES, type StemEngine, type StemName } from "@/audio/engine";
import { type MidiSynth } from "@/audio/midi-synth";
import { DEFAULT_MIXER, type MixerState, type MixerStripState } from "@/tab/edits";

interface StemMixerProps {
  engine: StemEngine;
  synth: MidiSynth;
  /**
   * Persisted mixer state from the parent. When undefined the mixer
   * boots with `DEFAULT_MIXER` — used on the first session for a song,
   * or in tests that mount the component standalone.
   */
  value?: MixerState;
  /**
   * Fires on every change. Parent stores the result in EditsFile.mixer
   * which gets autosaved alongside the rest of per-song state.
   */
  onChange?: (next: MixerState) => void;
}

type Track = StemName | "midi";
const TRACKS: readonly Track[] = [...STEM_NAMES, "midi"] as const;

const STRIP_GRID_COLS = "70px 1fr 36px 70px";

function effectiveTrackGain(strip: MixerStripState, anySoloed: boolean): number {
  if (strip.muted) return 0;
  if (anySoloed && !strip.soloed) return 0;
  return Math.max(0, Math.min(1, strip.volume));
}

export function StemMixer({ engine, synth, value, onChange }: StemMixerProps) {
  // Internal mirror of mixer state. Seeds from props on mount and on
  // every value-prop change (e.g. song switch reloads a different
  // saved mixer). Subsequent local changes flow through `onChange`
  // back to the parent; React's prop-down round-trip then re-syncs
  // via the same useEffect.
  const [state, setState] = useState<MixerState>(value ?? DEFAULT_MIXER);
  useEffect(() => {
    if (value) setState(value);
  }, [value]);

  // The mixer owns the gating logic so solo semantics stretch across stems
  // + the synth uniformly. We push the resulting per-track gain to the
  // engine via setVolume (skipping its own muted/soloed bookkeeping), to
  // the synth via setMasterVolume, and the master fader to the engine's
  // bus gain.
  useEffect(() => {
    const anySoloed = TRACKS.some((t) => state[t].soloed);
    for (const stem of STEM_NAMES) {
      engine.setVolume(stem, effectiveTrackGain(state[stem], anySoloed));
    }
    synth.setMasterVolume(effectiveTrackGain(state.midi, anySoloed));
    engine.setMasterVolume(state.master);
  }, [state, engine, synth]);

  const commit = useCallback(
    (next: MixerState) => {
      setState(next);
      onChange?.(next);
    },
    [onChange],
  );

  const updateStrip = (track: Track, patch: Partial<MixerStripState>) => {
    commit({ ...state, [track]: { ...state[track], ...patch } });
  };

  const onVolumeChange = (track: Track, volume: number) => updateStrip(track, { volume });
  const onToggleMute = (track: Track) => updateStrip(track, { muted: !state[track].muted });
  const onToggleSolo = (track: Track) => updateStrip(track, { soloed: !state[track].soloed });
  const onMasterChange = (master: number) => commit({ ...state, master });

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
      <MasterStrip value={state.master} onChange={onMasterChange} />
      <Divider color="border" />
      {TRACKS.map((track) => (
        <Strip
          key={track}
          track={track}
          state={state[track]}
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
  state: MixerStripState;
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
