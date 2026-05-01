import { describe, expect, test, vi } from "vitest";
import {
  effectiveGain,
  StemEngine,
  STEM_NAMES,
  type StemFlags,
  type StemUrls,
  type StemVolumes,
} from "./engine";

const NO_FLAGS: StemFlags = { vocals: false, drums: false, bass: false, other: false };
const FULL: StemVolumes = { vocals: 1, drums: 1, bass: 1, other: 1 };

const URLS: StemUrls = {
  vocals: "blob:vocals",
  drums: "blob:drums",
  bass: "blob:bass",
  other: "blob:other",
};

// ---------------------------------------------------------------------------
// Stub Web Audio + HTMLAudioElement so we can drive the engine from Node.
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
  public allGains: FakeGainNode[] = [];
  public mediaSources: object[] = [];
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
    this.allGains.push(node);
    return node;
  }
  createMediaElementSource(_el: HTMLAudioElement): MediaElementAudioSourceNode {
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaElementAudioSourceNode;
    this.mediaSources.push(source);
    return source;
  }
}

class FakeAudio {
  src = "";
  preload = "";
  crossOrigin: string | null = null;
  preservesPitch = false;
  playbackRate = 1;
  currentTime = 0;
  duration = 100;
  paused = true;
  ended = false;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
}

// Engine.load() does `new Audio()`; install the stub once for the whole suite.
(globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;

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

// ---------------------------------------------------------------------------
// Engine integration.
// ---------------------------------------------------------------------------

function setup() {
  const ctx = new FakeAudioContext();
  const engine = new StemEngine(ctx as unknown as AudioContext);
  engine.load(URLS);
  return {
    ctx,
    engine,
    gains: ctx.allGains,
    stemGains: ctx.allGains.slice(1),
    audios: STEM_NAMES.map(
      (n) =>
        // Reach into the engine via a typed-loosened any to inspect the
        // stub HTMLAudioElement bound to each stem name.
        (engine as unknown as { audios: Record<string, FakeAudio> }).audios[n],
    ),
  };
}

describe("StemEngine — element wiring", () => {
  test("load() creates one media-source + gain per stem", () => {
    const { ctx, audios } = setup();
    expect(audios.length).toBe(4);
    for (const a of audios) {
      expect(a.src).toMatch(/^blob:/);
      expect(a.preservesPitch).toBe(true);
    }
    expect(ctx.mediaSources.length).toBe(4);
    // 1 master + 4 stem gains.
    expect(ctx.allGains.length).toBe(5);
  });

  test("play / pause / seek delegate to elements", async () => {
    const { engine, audios } = setup();
    await engine.play();
    for (const a of audios) expect(a.play).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(true);

    engine.pause();
    for (const a of audios) expect(a.pause).toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);

    engine.seek(42);
    for (const a of audios) expect(a.currentTime).toBe(42);
  });

  test("getCurrentTime reads from the vocals element", () => {
    const { engine, audios } = setup();
    audios[0].currentTime = 12.5;
    expect(engine.getCurrentTime()).toBeCloseTo(12.5, 5);
  });

  test("seek clamps to [0, duration]", () => {
    const { engine, audios } = setup();
    engine.seek(-5);
    for (const a of audios) expect(a.currentTime).toBe(0);
    engine.seek(500);
    for (const a of audios) expect(a.currentTime).toBe(100); // FakeAudio.duration
  });

  test("STEM_NAMES contains the canonical four", () => {
    expect([...STEM_NAMES].toSorted()).toEqual(["bass", "drums", "other", "vocals"]);
  });
});

// ---------------------------------------------------------------------------
// Mixer setters + ramps.
// ---------------------------------------------------------------------------

describe("StemEngine mixer setters", () => {
  test("setVolume ramps the matching GainNode toward the new value", () => {
    const { ctx, engine, stemGains } = setup();
    ctx.currentTime = 5;
    engine.setVolume("bass", 0.2);
    const bassGain = stemGains[2]!;
    const ramp = bassGain.gain.linearRampToValueAtTime;
    expect(ramp).toHaveBeenCalled();
    const lastCall = ramp.mock.calls[ramp.mock.calls.length - 1]!;
    expect(lastCall[0]).toBeCloseTo(0.2, 5);
    expect(lastCall[1]).toBeCloseTo(5 + 0.01, 5);
  });

  test("setMuted forces gain to 0; unmute restores volume", () => {
    const { engine, stemGains } = setup();
    engine.setVolume("drums", 0.7);
    const ramp = stemGains[1]!.gain.linearRampToValueAtTime;
    ramp.mockClear();

    engine.setMuted("drums", true);
    let last = ramp.mock.calls.at(-1)!;
    expect(last[0]).toBe(0);

    engine.setMuted("drums", false);
    last = ramp.mock.calls.at(-1)!;
    expect(last[0]).toBeCloseTo(0.7, 5);
  });

  test("solo silences the other three stems via ramp", () => {
    const { engine, stemGains } = setup();
    for (const g of stemGains) g.gain.linearRampToValueAtTime.mockClear();

    engine.setSoloed("bass", true);
    const [vocalsRamp, drumsRamp, bassRamp, otherRamp] = stemGains.map(
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

  test("setMasterVolume clamps and ramps the master gain", () => {
    const { ctx, engine, gains } = setup();
    const master = gains[0]!;

    ctx.currentTime = 3;
    engine.setMasterVolume(0.4);
    let last = master.gain.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(last[0]).toBeCloseTo(0.4, 5);
    expect(last[1]).toBeCloseTo(3 + 0.01, 5);

    engine.setMasterVolume(5);
    last = master.gain.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(last[0]).toBe(1);
    expect(engine.getMasterVolume()).toBe(1);

    engine.setMasterVolume(-2);
    expect(engine.getMasterVolume()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tempo (T7).
// ---------------------------------------------------------------------------

describe("StemEngine.setTempo", () => {
  test("writes playbackRate + preservesPitch on every element", () => {
    const { engine, audios } = setup();
    engine.setTempo(0.75);
    for (const a of audios) {
      expect(a.playbackRate).toBeCloseTo(0.75, 5);
      expect(a.preservesPitch).toBe(true);
    }
    expect(engine.getTempo()).toBeCloseTo(0.75, 5);
  });

  test("clamps to [0.5, 1.0]", () => {
    const { engine, audios } = setup();
    engine.setTempo(0.1);
    expect(engine.getTempo()).toBe(0.5);
    for (const a of audios) expect(a.playbackRate).toBe(0.5);

    engine.setTempo(2.5);
    expect(engine.getTempo()).toBe(1);
    for (const a of audios) expect(a.playbackRate).toBe(1);
  });

  test("tempo set before load is applied to elements created by load()", () => {
    const ctx = new FakeAudioContext();
    const engine = new StemEngine(ctx as unknown as AudioContext);
    engine.setTempo(0.6);
    engine.load(URLS);
    const audios = STEM_NAMES.map(
      (n) => (engine as unknown as { audios: Record<string, FakeAudio> }).audios[n],
    );
    for (const a of audios) {
      expect(a.playbackRate).toBeCloseTo(0.6, 5);
      expect(a.preservesPitch).toBe(true);
    }
  });
});
