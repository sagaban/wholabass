import { useState } from "react";
import { Box, Divider, Grid, HStack, styled } from "styled-system/jsx";
import { Button, Slider } from "@/components/ui";
import { STEM_NAMES, type StemEngine, type StemName } from "@/audio/engine";

interface StemMixerProps {
  engine: StemEngine;
}

interface StripState {
  volume: number;
  muted: boolean;
  soloed: boolean;
}

const INITIAL_STRIP: StripState = { volume: 1, muted: false, soloed: false };
const STRIP_GRID_COLS = "70px 1fr 36px 70px";

export function StemMixer({ engine }: StemMixerProps) {
  const [strips, setStrips] = useState<Record<StemName, StripState>>({
    vocals: INITIAL_STRIP,
    drums: INITIAL_STRIP,
    bass: INITIAL_STRIP,
    other: INITIAL_STRIP,
  });
  const [master, setMaster] = useState(1);

  const update = (stem: StemName, patch: Partial<StripState>) => {
    setStrips((s) => ({ ...s, [stem]: { ...s[stem], ...patch } }));
  };

  const onVolumeChange = (stem: StemName, value: number) => {
    update(stem, { volume: value });
    engine.setVolume(stem, value);
  };

  const onToggleMute = (stem: StemName) => {
    const next = !strips[stem].muted;
    update(stem, { muted: next });
    engine.setMuted(stem, next);
  };

  const onToggleSolo = (stem: StemName) => {
    const next = !strips[stem].soloed;
    update(stem, { soloed: next });
    engine.setSoloed(stem, next);
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
      {STEM_NAMES.map((stem) => (
        <Strip
          key={stem}
          stem={stem}
          state={strips[stem]}
          onVolumeChange={(v) => onVolumeChange(stem, v)}
          onToggleMute={() => onToggleMute(stem)}
          onToggleSolo={() => onToggleSolo(stem)}
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
  stem: StemName;
  state: StripState;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}

function Strip({ stem, state, onVolumeChange, onToggleMute, onToggleSolo }: StripProps) {
  return (
    <Grid gridTemplateColumns={STRIP_GRID_COLS} alignItems="center" gap="2">
      <styled.div fontSize="sm" textTransform="capitalize">
        {stem}
      </styled.div>

      <Slider.Root
        value={[state.volume]}
        onValueChange={(d) => onVolumeChange(d.value[0] ?? 0)}
        min={0}
        max={1}
        step={0.01}
        aria-label={[`${stem} volume`]}
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
          aria-label={`mute ${stem}`}
        >
          M
        </Button>
        <Button
          size="xs"
          variant={state.soloed ? "solid" : "outline"}
          onClick={onToggleSolo}
          aria-pressed={state.soloed}
          aria-label={`solo ${stem}`}
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
