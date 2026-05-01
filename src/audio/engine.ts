/**
 * Multi-stem synced playback on one shared AudioContext.
 *
 * All four stems are scheduled with a single `start(time)` so they stay
 * sample-aligned. Seek = stop sources + recreate from the new offset.
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export const STEM_NAMES: readonly StemName[] = [
  "vocals",
  "drums",
  "bass",
  "other",
] as const;

export type StemBuffers = Record<StemName, AudioBuffer>;

export type EngineState =
  | { kind: "stopped" }
  | { kind: "paused"; offset: number }
  | { kind: "playing"; ctxStartTime: number; offsetAtStart: number };

/**
 * Pure time math. `ctxNow` is `audioContext.currentTime`; `duration` is the
 * stem length in seconds. Result is clamped to `[0, duration]`.
 */
export function currentOffset(
  state: EngineState,
  ctxNow: number,
  duration: number,
): number {
  switch (state.kind) {
    case "stopped":
      return 0;
    case "paused":
      return clamp(state.offset, 0, duration);
    case "playing":
      return clamp(
        state.offsetAtStart + (ctxNow - state.ctxStartTime),
        0,
        duration,
      );
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class StemEngine {
  private readonly ctx: AudioContext;
  private buffers: StemBuffers | null = null;
  private sources: Partial<Record<StemName, AudioBufferSourceNode>> = {};
  private gains: Partial<Record<StemName, GainNode>> = {};
  private state: EngineState = { kind: "stopped" };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  load(buffers: StemBuffers): void {
    this.stopSources();
    this.buffers = buffers;
    this.state = { kind: "stopped" };
    for (const name of STEM_NAMES) {
      if (!this.gains[name]) {
        const g = this.ctx.createGain();
        g.gain.value = 1.0;
        g.connect(this.ctx.destination);
        this.gains[name] = g;
      }
    }
  }

  play(offset?: number): void {
    if (!this.buffers) return;
    const startOffset =
      offset ??
      (this.state.kind === "paused" ? this.state.offset : 0);
    this.stopSources();
    const startTime = this.ctx.currentTime;
    for (const name of STEM_NAMES) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[name];
      src.connect(this.gains[name]!);
      src.start(startTime, Math.max(0, startOffset));
      this.sources[name] = src;
    }
    this.state = {
      kind: "playing",
      ctxStartTime: startTime,
      offsetAtStart: startOffset,
    };
  }

  pause(): void {
    if (this.state.kind !== "playing") return;
    const offset = currentOffset(this.state, this.ctx.currentTime, this.duration);
    this.stopSources();
    this.state = { kind: "paused", offset };
  }

  seek(offset: number): void {
    const clamped = clamp(offset, 0, this.duration);
    if (this.state.kind === "playing") {
      this.play(clamped);
    } else {
      this.state = { kind: "paused", offset: clamped };
    }
  }

  getCurrentTime(): number {
    return currentOffset(this.state, this.ctx.currentTime, this.duration);
  }

  get duration(): number {
    return this.buffers?.vocals.duration ?? 0;
  }

  get isPlaying(): boolean {
    return this.state.kind === "playing";
  }

  get hasBuffers(): boolean {
    return this.buffers !== null;
  }

  private stopSources(): void {
    for (const name of STEM_NAMES) {
      const src = this.sources[name];
      if (src) {
        try {
          src.stop();
        } catch {
          // already stopped or never started; safe to ignore
        }
        src.disconnect();
        delete this.sources[name];
      }
    }
  }
}
