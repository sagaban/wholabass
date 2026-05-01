import { describe, expect, test, vi } from "vitest";
import {
  currentAudioPos,
  effectiveGain,
  StemEngine,
  STEM_NAMES,
  type EngineState,
  type StemBuffers,
  type StemFlags,
  type StemVolumes,
  type StretcherFactory,
  type StretcherNode,
} from "./engine";

const NO_FLAGS: StemFlags = { vocals: false, drums: false, bass: false, other: false };
const FULL: StemVolumes = { vocals: 1, drums: 1, bass: 1, other: 1 };

// ---------------------------------------------------------------------------
// Pure math.
// ---------------------------------------------------------------------------

describe("currentAudioPos", () => {
  test("stopped → 0", () => {
    const s: EngineState = { kind: "stopped" };
    expect(currentAudioPos(s, 99, 1, 100)).toBe(0);
  });

  test("paused → offset, clamped to duration", () => {
    expect(currentAudioPos({ kind: "paused", offset: 42 }, 0, 1, 100)).toBe(42);
    expect(currentAudioPos({ kind: "paused", offset: 200 }, 0, 1, 100)).toBe(100);
    expect(currentAudioPos({ kind: "paused", offset: -5 }, 0, 1, 100)).toBe(0);
  });

  test("playing at 1x: position equals offset + elapsed wall-clock", () => {
    const s: EngineState = { kind: "playing", ctxStartTime: 10, offsetAtStart: 30 };
    expect(currentAudioPos(s, 12, 1, 100)).toBe(32);
  });

  test("playing at 0.5x: audio advances at half wall-clock rate", () => {
    const s: EngineState = { kind: "playing", ctxStartTime: 0, offsetAtStart: 0 };
    // 4 seconds of wall-clock at half speed → 2 seconds of audio.
    expect(currentAudioPos(s, 4, 0.5, 100)).toBeCloseTo(2, 5);
  });

  test("playing past end clamps to duration", () => {
    const s: EngineState = { kind: "playing", ctxStartTime: 0, offsetAtStart: 95 };
    expect(currentAudioPos(s, 10, 1, 100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Mixer math.
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

  test("multiple solos each get their own volume", () => {
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

// ---------------------------------------------------------------------------
// Stub Web Audio + stretcher so we can drive the engine from Node.
// ---------------------------------------------------------------------------

type FakeAudioParam = AudioParam & {
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
};

function makeAudioParam(initial = 1): FakeAudioParam {
  return {
    value: initial,
    linearRampToValueAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  } as unknown as FakeAudioParam;
}

type FakeGainNode = GainNode & {
  gain: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

class FakeAudioContext {
  public currentTime = 0;
  public destination = {} as AudioDestinationNode;
  public allGains: FakeGainNode[] = [];
  public sourcesCreated = 0;
  createGain(): GainNode {
    const node = {
      gain: makeAudioParam(1),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as FakeGainNode;
    this.allGains.push(node);
    return node;
  }
  createBufferSource(): AudioBufferSourceNode {
    this.sourcesCreated++;
    return {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as AudioBufferSourceNode;
  }
}

interface FakeStretcher {
  tempo: FakeAudioParam;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeStretcherFactory(): {
  factory: StretcherFactory;
  stretchers: FakeStretcher[];
} {
  const stretchers: FakeStretcher[] = [];
  const factory: StretcherFactory = () => {
    const s: FakeStretcher = {
      tempo: makeAudioParam(1),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    stretchers.push(s);
    return s as unknown as StretcherNode;
  };
  return { factory, stretchers };
}

function makeBuffers(duration: number): StemBuffers {
  const buf = { duration } as AudioBuffer;
  return { vocals: buf, drums: buf, bass: buf, other: buf };
}

function setup() {
  const ctx = new FakeAudioContext();
  const { factory, stretchers } = makeStretcherFactory();
  const engine = new StemEngine(ctx as unknown as AudioContext, factory);
  engine.load(makeBuffers(100));
  return {
    ctx,
    engine,
    stretchers,
    gains: ctx.allGains,
    stemGains: ctx.allGains.slice(1), // first gain is master
  };
}

// ---------------------------------------------------------------------------
// Engine integration.
// ---------------------------------------------------------------------------

describe("StemEngine — wiring", () => {
  test("load() creates one stretcher + one gain per stem (plus master)", () => {
    const { ctx, stretchers } = setup();
    expect(stretchers.length).toBe(4);
    expect(ctx.allGains.length).toBe(5); // master + 4 stems
    for (const s of stretchers) expect(s.connect).toHaveBeenCalled();
  });

  test("play creates a fresh BufferSource per stem and starts at the offset", () => {
    const { ctx, engine } = setup();
    ctx.currentTime = 5;
    engine.play(20);
    expect(ctx.sourcesCreated).toBe(4);
    expect(engine.isPlaying).toBe(true);
    expect(engine.getCurrentTime()).toBe(20);
  });

  test("pause snapshots audio position; resume continues from there", () => {
    const { ctx, engine } = setup();
    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 7.5;
    engine.pause();
    expect(engine.isPlaying).toBe(false);
    expect(engine.getCurrentTime()).toBeCloseTo(7.5, 5);

    ctx.currentTime = 999;
    engine.play();
    expect(engine.getCurrentTime()).toBeCloseTo(7.5, 5);
  });

  test("seek-while-playing restarts at the new offset", () => {
    const { ctx, engine } = setup();
    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 2;
    engine.seek(60);
    expect(engine.isPlaying).toBe(true);
    expect(engine.getCurrentTime()).toBe(60);
  });

  test("seek-while-paused stores the new offset", () => {
    const { engine } = setup();
    engine.seek(33);
    expect(engine.isPlaying).toBe(false);
    expect(engine.getCurrentTime()).toBe(33);
  });

  test("STEM_NAMES contains the canonical four", () => {
    expect([...STEM_NAMES].toSorted()).toEqual(["bass", "drums", "other", "vocals"]);
  });
});

// ---------------------------------------------------------------------------
// Mixer setters + ramps.
// ---------------------------------------------------------------------------

describe("StemEngine mixer setters", () => {
  test("setVolume ramps the matching gain", () => {
    const { ctx, engine, stemGains } = setup();
    ctx.currentTime = 5;
    engine.setVolume("bass", 0.2);
    const ramp = stemGains[2]!.gain.linearRampToValueAtTime;
    const last = ramp.mock.calls.at(-1)!;
    expect(last[0]).toBeCloseTo(0.2, 5);
    expect(last[1]).toBeCloseTo(5 + 0.01, 5);
  });

  test("setMuted then unmute restores the saved volume", () => {
    const { engine, stemGains } = setup();
    engine.setVolume("drums", 0.7);
    const ramp = stemGains[1]!.gain.linearRampToValueAtTime;
    ramp.mockClear();

    engine.setMuted("drums", true);
    expect(ramp.mock.calls.at(-1)![0]).toBe(0);
    engine.setMuted("drums", false);
    expect(ramp.mock.calls.at(-1)![0]).toBeCloseTo(0.7, 5);
  });

  test("solo silences the other three stems", () => {
    const { engine, stemGains } = setup();
    for (const g of stemGains) g.gain.linearRampToValueAtTime.mockClear();

    engine.setSoloed("bass", true);
    const [vocals, drums, bass, other] = stemGains.map((g) => g.gain.linearRampToValueAtTime);
    expect(vocals.mock.calls.at(-1)![0]).toBe(0);
    expect(drums.mock.calls.at(-1)![0]).toBe(0);
    expect(bass.mock.calls.at(-1)![0]).toBe(1);
    expect(other.mock.calls.at(-1)![0]).toBe(0);
  });

  test("setMasterVolume clamps + ramps the master gain", () => {
    const { ctx, engine, gains } = setup();
    const master = gains[0]!;
    ctx.currentTime = 3;
    engine.setMasterVolume(0.4);
    const ramp = master.gain.linearRampToValueAtTime;
    expect(ramp.mock.calls.at(-1)![0]).toBeCloseTo(0.4, 5);
    expect(ramp.mock.calls.at(-1)![1]).toBeCloseTo(3 + 0.01, 5);

    engine.setMasterVolume(5);
    expect(engine.getMasterVolume()).toBe(1);
    engine.setMasterVolume(-2);
    expect(engine.getMasterVolume()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tempo (T7).
// ---------------------------------------------------------------------------

describe("StemEngine.setTempo", () => {
  test("ramps every stretcher's tempo and clamps to [0.5, 1.0]", () => {
    const { ctx, engine, stretchers } = setup();
    ctx.currentTime = 1;
    engine.setTempo(0.6);
    expect(engine.getTempo()).toBeCloseTo(0.6, 5);
    for (const s of stretchers) {
      const last = s.tempo.linearRampToValueAtTime.mock.calls.at(-1)!;
      expect(last[0]).toBeCloseTo(0.6, 5);
    }

    engine.setTempo(0.1);
    expect(engine.getTempo()).toBe(0.5);
    engine.setTempo(2.5);
    expect(engine.getTempo()).toBe(1);
  });

  test("changing tempo mid-playback keeps getCurrentTime continuous", () => {
    const { ctx, engine } = setup();
    ctx.currentTime = 0;
    engine.play(0);
    ctx.currentTime = 4;
    expect(engine.getCurrentTime()).toBeCloseTo(4, 5);

    engine.setTempo(0.5);
    // Right after the tempo change, no extra wall-clock has passed, so
    // the audio position should still be 4 (the snapshot).
    expect(engine.getCurrentTime()).toBeCloseTo(4, 5);

    // Now run another 4 wall-clock seconds; at 0.5x tempo we should be at 6.
    ctx.currentTime = 8;
    expect(engine.getCurrentTime()).toBeCloseTo(6, 5);
  });
});
