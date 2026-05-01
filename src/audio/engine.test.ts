import { describe, expect, test, vi } from "vitest";
import {
  currentOffset,
  effectiveGain,
  StemEngine,
  STEM_NAMES,
  type EngineState,
  type StemBuffers,
  type StemFlags,
  type StemVolumes,
} from "./engine";

const NO_FLAGS: StemFlags = { vocals: false, drums: false, bass: false, other: false };
const FULL: StemVolumes = { vocals: 1, drums: 1, bass: 1, other: 1 };

describe("currentOffset", () => {
  test("stopped → 0", () => {
    const s: EngineState = { kind: "stopped" };
    expect(currentOffset(s, 99, 100)).toBe(0);
  });

  test("paused → offset, clamped to duration", () => {
    expect(currentOffset({ kind: "paused", offset: 42 }, 0, 100)).toBe(42);
    expect(currentOffset({ kind: "paused", offset: 200 }, 0, 100)).toBe(100);
    expect(currentOffset({ kind: "paused", offset: -5 }, 0, 100)).toBe(0);
  });

  test("playing → offsetAtStart + (ctxNow - ctxStartTime)", () => {
    const s: EngineState = {
      kind: "playing",
      ctxStartTime: 10,
      offsetAtStart: 30,
    };
    expect(currentOffset(s, 12, 100)).toBe(32); // played 2s into a 30s start offset
  });

  test("playing past end clamps to duration", () => {
    const s: EngineState = {
      kind: "playing",
      ctxStartTime: 0,
      offsetAtStart: 95,
    };
    expect(currentOffset(s, 10, 100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Engine integration tests with a stub AudioContext.
// ---------------------------------------------------------------------------

type FakeGainNode = GainNode & {
  gain: AudioParam & {
    linearRampToValueAtTime: ReturnType<typeof vi.fn>;
    setValueAtTime: ReturnType<typeof vi.fn>;
    cancelScheduledValues: ReturnType<typeof vi.fn>;
  };
};

class FakeAudioContext {
  public currentTime = 0;
  public destination = {} as AudioDestinationNode;
  public lastGain?: FakeGainNode;
  public allGains: FakeGainNode[] = [];
  createGain(): GainNode {
    const node = {
      gain: {
        value: 1,
        linearRampToValueAtTime: vi.fn(),
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      } as unknown as FakeGainNode["gain"],
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as FakeGainNode;
    this.lastGain = node;
    this.allGains.push(node);
    return node;
  }
  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as AudioBufferSourceNode;
  }
}

function makeBuffers(duration: number): StemBuffers {
  const buf = { duration } as AudioBuffer;
  return {
    vocals: buf,
    drums: buf,
    bass: buf,
    other: buf,
  };
}

describe("StemEngine", () => {
  test("getCurrentTime is 0 before load", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    expect(engine.getCurrentTime()).toBe(0);
    expect(engine.duration).toBe(0);
    expect(engine.isPlaying).toBe(false);
  });

  test("play(offset) starts all 4 sources at offset", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));

    ctx.currentTime = 5;
    engine.play(20);

    expect(engine.isPlaying).toBe(true);
    // After 0s of wall-clock time we should be at the offset itself.
    expect(engine.getCurrentTime()).toBe(20);

    // Advance the clock 3s: position should follow.
    ctx.currentTime = 8;
    expect(engine.getCurrentTime()).toBeCloseTo(23, 5);
  });

  test("pause captures the play head; resume continues from there", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));

    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 7.5;
    engine.pause();
    expect(engine.isPlaying).toBe(false);
    expect(engine.getCurrentTime()).toBeCloseTo(7.5, 5);

    ctx.currentTime = 999; // arbitrary advance while paused
    engine.play();
    // First sample of the resumed play head equals the pause position.
    expect(engine.getCurrentTime()).toBeCloseTo(7.5, 5);
  });

  test("seek while playing restarts at offset", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));

    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 2;
    engine.seek(60);
    expect(engine.isPlaying).toBe(true);
    expect(engine.getCurrentTime()).toBe(60);
  });

  test("seek while paused just updates the stored offset", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));

    engine.seek(33);
    expect(engine.isPlaying).toBe(false);
    expect(engine.getCurrentTime()).toBe(33);
  });

  test("seek clamps to [0, duration]", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));
    engine.seek(-5);
    expect(engine.getCurrentTime()).toBe(0);
    engine.seek(500);
    expect(engine.getCurrentTime()).toBe(100);
  });

  test("STEM_NAMES contains the canonical four", () => {
    expect([...STEM_NAMES].sort()).toEqual(["bass", "drums", "other", "vocals"]);
  });
});

// ---------------------------------------------------------------------------
// Mixer math + gain ramp.
// ---------------------------------------------------------------------------

describe("effectiveGain", () => {
  test("default: stem volume passes through", () => {
    const vols: StemVolumes = { vocals: 0.4, drums: 0.7, bass: 1, other: 0.5 };
    expect(effectiveGain(vols, NO_FLAGS, NO_FLAGS, "vocals")).toBe(0.4);
    expect(effectiveGain(vols, NO_FLAGS, NO_FLAGS, "bass")).toBe(1);
  });

  test("muted stem is forced to 0 even with full volume", () => {
    const muted: StemFlags = { ...NO_FLAGS, drums: true };
    expect(effectiveGain(FULL, muted, NO_FLAGS, "drums")).toBe(0);
    expect(effectiveGain(FULL, muted, NO_FLAGS, "vocals")).toBe(1);
  });

  test("any solo silences non-solo stems", () => {
    const soloed: StemFlags = { ...NO_FLAGS, bass: true };
    expect(effectiveGain(FULL, NO_FLAGS, soloed, "bass")).toBe(1);
    expect(effectiveGain(FULL, NO_FLAGS, soloed, "vocals")).toBe(0);
    expect(effectiveGain(FULL, NO_FLAGS, soloed, "drums")).toBe(0);
  });

  test("multiple solos sum (each soloed stem audible at its volume)", () => {
    const soloed: StemFlags = { ...NO_FLAGS, bass: true, drums: true };
    const vols: StemVolumes = { vocals: 1, drums: 0.6, bass: 0.8, other: 1 };
    expect(effectiveGain(vols, NO_FLAGS, soloed, "bass")).toBe(0.8);
    expect(effectiveGain(vols, NO_FLAGS, soloed, "drums")).toBe(0.6);
    expect(effectiveGain(vols, NO_FLAGS, soloed, "vocals")).toBe(0);
  });

  test("solo + mute on the same stem stays silent", () => {
    const muted: StemFlags = { ...NO_FLAGS, bass: true };
    const soloed: StemFlags = { ...NO_FLAGS, bass: true };
    expect(effectiveGain(FULL, muted, soloed, "bass")).toBe(0);
  });

  test("volume is clamped to [0, 1]", () => {
    expect(effectiveGain({ ...FULL, vocals: -0.5 }, NO_FLAGS, NO_FLAGS, "vocals")).toBe(0);
    expect(effectiveGain({ ...FULL, vocals: 5 }, NO_FLAGS, NO_FLAGS, "vocals")).toBe(1);
  });
});

describe("StemEngine mixer setters", () => {
  function setup() {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.load(makeBuffers(100));
    // 4 gain nodes, one per stem, in STEM_NAMES order.
    return { ctx, engine, gains: ctx.allGains };
  }

  test("setVolume ramps the matching GainNode toward the new value", () => {
    const { ctx, engine, gains } = setup();
    ctx.currentTime = 5;
    engine.setVolume("bass", 0.2);
    // bass is the 3rd entry in STEM_NAMES → index 2.
    const bassGain = gains[2]!;
    const ramp = bassGain.gain.linearRampToValueAtTime;
    expect(ramp).toHaveBeenCalled();
    const lastCall = ramp.mock.calls[ramp.mock.calls.length - 1]!;
    expect(lastCall[0]).toBeCloseTo(0.2, 5);
    expect(lastCall[1]).toBeCloseTo(5 + 0.01, 5); // ~10ms ramp
  });

  test("setMuted forces gain to 0; unmute restores volume", () => {
    const { engine, gains } = setup();
    engine.setVolume("drums", 0.7);
    const ramp = gains[1]!.gain.linearRampToValueAtTime;
    ramp.mockClear();

    engine.setMuted("drums", true);
    let last = ramp.mock.calls.at(-1)!;
    expect(last[0]).toBe(0);

    engine.setMuted("drums", false);
    last = ramp.mock.calls.at(-1)!;
    expect(last[0]).toBeCloseTo(0.7, 5);
  });

  test("solo silences the other three stems via ramp", () => {
    const { engine, gains } = setup();
    // Clear initial load() calls.
    for (const g of gains) g.gain.linearRampToValueAtTime.mockClear();

    engine.setSoloed("bass", true);
    // bass = idx 2; rest should ramp to 0.
    const [vocalsRamp, drumsRamp, bassRamp, otherRamp] = gains.map(
      (g) => g.gain.linearRampToValueAtTime,
    );
    expect(vocalsRamp.mock.calls.at(-1)![0]).toBe(0);
    expect(drumsRamp.mock.calls.at(-1)![0]).toBe(0);
    expect(bassRamp.mock.calls.at(-1)![0]).toBe(1);
    expect(otherRamp.mock.calls.at(-1)![0]).toBe(0);

    engine.setSoloed("bass", false);
    expect(vocalsRamp.mock.calls.at(-1)![0]).toBe(1);
    expect(drumsRamp.mock.calls.at(-1)![0]).toBe(1);
  });

  test("getters reflect stored state", () => {
    const { engine } = setup();
    engine.setVolume("vocals", 0.3);
    engine.setMuted("drums", true);
    engine.setSoloed("bass", true);
    expect(engine.getVolume("vocals")).toBe(0.3);
    expect(engine.isMuted("drums")).toBe(true);
    expect(engine.isSoloed("bass")).toBe(true);
    expect(engine.isMuted("vocals")).toBe(false);
  });
});
