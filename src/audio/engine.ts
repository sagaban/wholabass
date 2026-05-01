/**
 * Multi-stem synced playback on one shared AudioContext.
 *
 * All four stems are scheduled with a single `start(time)` so they stay
 * sample-aligned. Seek = stop sources + recreate from the new offset.
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export const STEM_NAMES: readonly StemName[] = ["vocals", "drums", "bass", "other"] as const;

export type StemBuffers = Record<StemName, AudioBuffer>;

export type EngineState =
  | { kind: "stopped" }
  | { kind: "paused"; offset: number }
  | { kind: "playing"; ctxStartTime: number; offsetAtStart: number };

/**
 * Pure time math. `ctxNow` is `audioContext.currentTime`; `duration` is the
 * stem length in seconds. Result is clamped to `[0, duration]`.
 */
export function currentOffset(state: EngineState, ctxNow: number, duration: number): number {
  switch (state.kind) {
    case "stopped":
      return 0;
    case "paused":
      return clamp(state.offset, 0, duration);
    case "playing":
      return clamp(state.offsetAtStart + (ctxNow - state.ctxStartTime), 0, duration);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export type StemFlags = Record<StemName, boolean>;
export type StemVolumes = Record<StemName, number>;

/**
 * Per-stem effective gain given user volumes + mute/solo flags.
 *
 * Rules:
 *   - if any stem is soloed: only stems that are soloed AND not muted get
 *     their own volume; everyone else is forced to 0.
 *   - else: muted stems → 0; everyone else → their own volume.
 */
export function effectiveGain(
  volumes: StemVolumes,
  muted: StemFlags,
  soloed: StemFlags,
  stem: StemName,
): number {
  const anySoloed = STEM_NAMES.some((n) => soloed[n]);
  if (muted[stem]) return 0;
  if (anySoloed && !soloed[stem]) return 0;
  return clamp(volumes[stem], 0, 1);
}

const RAMP_SECONDS = 0.01;

const ZERO_FLAGS: StemFlags = {
  vocals: false,
  drums: false,
  bass: false,
  other: false,
};
const FULL_VOLUMES: StemVolumes = {
  vocals: 1,
  drums: 1,
  bass: 1,
  other: 1,
};

export class StemEngine {
  private readonly ctx: AudioContext;
  private buffers: StemBuffers | null = null;
  private sources: Partial<Record<StemName, AudioBufferSourceNode>> = {};
  private gains: Partial<Record<StemName, GainNode>> = {};
  private master: GainNode | null = null;
  private state: EngineState = { kind: "stopped" };
  private volumes: StemVolumes = { ...FULL_VOLUMES };
  private muted: StemFlags = { ...ZERO_FLAGS };
  private soloed: StemFlags = { ...ZERO_FLAGS };
  private masterVolume = 1;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  load(buffers: StemBuffers): void {
    this.stopSources();
    this.buffers = buffers;
    this.state = { kind: "stopped" };
    if (!this.master) {
      const m = this.ctx.createGain();
      m.gain.setValueAtTime(this.masterVolume, this.ctx.currentTime);
      m.connect(this.ctx.destination);
      this.master = m;
    }
    for (const name of STEM_NAMES) {
      if (!this.gains[name]) {
        const g = this.ctx.createGain();
        // Anchor the AudioParam timeline so future linearRampToValueAtTime
        // calls have a defined start value.
        g.gain.setValueAtTime(
          effectiveGain(this.volumes, this.muted, this.soloed, name),
          this.ctx.currentTime,
        );
        g.connect(this.master);
        this.gains[name] = g;
      }
    }
  }

  setVolume(stem: StemName, value: number): void {
    this.volumes[stem] = clamp(value, 0, 1);
    this.applyMix();
  }

  setMasterVolume(value: number): void {
    this.masterVolume = clamp(value, 0, 1);
    if (!this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(this.masterVolume, now + RAMP_SECONDS);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setMuted(stem: StemName, on: boolean): void {
    this.muted[stem] = on;
    this.applyMix();
  }

  setSoloed(stem: StemName, on: boolean): void {
    this.soloed[stem] = on;
    this.applyMix();
  }

  getVolume(stem: StemName): number {
    return this.volumes[stem];
  }

  isMuted(stem: StemName): boolean {
    return this.muted[stem];
  }

  isSoloed(stem: StemName): boolean {
    return this.soloed[stem];
  }

  /** Recompute effective gains and ramp every GainNode to its new value. */
  private applyMix(): void {
    const now = this.ctx.currentTime;
    const target = now + RAMP_SECONDS;
    for (const name of STEM_NAMES) {
      const node = this.gains[name];
      if (!node) continue;
      const value = effectiveGain(this.volumes, this.muted, this.soloed, name);
      // Cancel pending automation, anchor the current value at `now`, then
      // ramp. Without the anchor the ramp's start value is undefined when
      // gain.value was set via the property assignment rather than scheduled.
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(value, target);
    }
  }

  play(offset?: number): void {
    if (!this.buffers) return;
    const startOffset = offset ?? (this.state.kind === "paused" ? this.state.offset : 0);
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
