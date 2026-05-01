import { describe, expect, test, vi } from "vitest";
import {
  currentOffset,
  StemEngine,
  STEM_NAMES,
  type EngineState,
  type StemBuffers,
} from "./engine";

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

class FakeAudioContext {
  public currentTime = 0;
  public destination = {} as AudioDestinationNode;
  createGain(): GainNode {
    return {
      gain: { value: 1 } as AudioParam,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;
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
