import { useState } from "react";
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

export function StemMixer({ engine }: StemMixerProps) {
  const [strips, setStrips] = useState<Record<StemName, StripState>>({
    vocals: INITIAL_STRIP,
    drums: INITIAL_STRIP,
    bass: INITIAL_STRIP,
    other: INITIAL_STRIP,
  });

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

  return (
    <div
      style={{
        marginTop: "0.75rem",
        padding: "0.75rem",
        border: "1px solid #333",
        borderRadius: 8,
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "0.75rem",
        width: "min(540px, 100%)",
      }}
    >
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
    </div>
  );
}

interface StripProps {
  stem: StemName;
  state: StripState;
  onVolumeChange: (value: number) => void;
  onToggleMute: () => void;
  onToggleSolo: () => void;
}

function Strip({
  stem,
  state,
  onVolumeChange,
  onToggleMute,
  onToggleSolo,
}: StripProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      <div style={{ fontSize: "0.85rem", textTransform: "capitalize" }}>{stem}</div>

      <Slider.Root
        orientation="vertical"
        value={[state.volume]}
        onValueChange={(d) => onVolumeChange(d.value[0] ?? 0)}
        min={0}
        max={1}
        step={0.01}
        style={{ height: 120 }}
        aria-label={[`${stem} volume`]}
      >
        <Slider.Control style={{ height: "100%" }}>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumb index={0}>
            <Slider.HiddenInput />
          </Slider.Thumb>
        </Slider.Control>
      </Slider.Root>

      <div
        style={{
          fontVariantNumeric: "tabular-nums",
          fontSize: "0.8rem",
          opacity: 0.7,
        }}
      >
        {Math.round(state.volume * 100)}
      </div>

      <div style={{ display: "flex", gap: "0.25rem" }}>
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
      </div>
    </div>
  );
}
