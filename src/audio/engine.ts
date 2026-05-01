/**
 * Multi-stem synced playback with pitch-preserving time-stretch via the
 * SoundTouch AudioWorklet. Per stem:
 *
 *     AudioBufferSourceNode → SoundTouchNode → GainNode → master → destination
 *
 * The worklet does the time-stretch (its `tempo` AudioParam is independent
 * of pitch), so playback stays smooth even on percussive material at 50%.
 *
 * The stretcher is injected as a factory so unit tests can stub it without
 * a real AudioWorkletNode.
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export const STEM_NAMES: readonly StemName[] = ["vocals", "drums", "bass", "other"] as const;

export type StemBuffers = Record<StemName, AudioBuffer>;
export type StemFlags = Record<StemName, boolean>;
export type StemVolumes = Record<StemName, number>;

/** The minimal surface we need from a tempo-stretching worklet node. */
export interface StretcherNode extends AudioNode {
  readonly tempo: AudioParam;
}

export type StretcherFactory = (ctx: AudioContext) => StretcherNode;

export type EngineState =
  | { kind: "stopped" }
  | { kind: "paused"; offset: number }
  | { kind: "playing"; ctxStartTime: number; offsetAtStart: number };

const RAMP_SECONDS = 0.01;
const TEMPO_MIN = 0.5;
const TEMPO_MAX = 1.0;

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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure tempo-aware audio-position math.
 * `audio_pos = offsetAtStart + (ctxNow - ctxStartTime) * tempo` while playing,
 * because tempo<1 means the audio playhead advances slower than wall-clock.
 */
export function currentAudioPos(
  state: EngineState,
  ctxNow: number,
  tempo: number,
  duration: number,
): number {
  switch (state.kind) {
    case "stopped":
      return 0;
    case "paused":
      return clamp(state.offset, 0, duration);
    case "playing": {
      const elapsed = (ctxNow - state.ctxStartTime) * tempo;
      return clamp(state.offsetAtStart + elapsed, 0, duration);
    }
  }
}

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

export class StemEngine {
  private readonly ctx: AudioContext;
  private readonly stretcherFactory: StretcherFactory;
  private buffers: StemBuffers | null = null;
  private sources: Partial<Record<StemName, AudioBufferSourceNode>> = {};
  private stretchers: Partial<Record<StemName, StretcherNode>> = {};
  private gains: Partial<Record<StemName, GainNode>> = {};
  private master: GainNode | null = null;
  private state: EngineState = { kind: "stopped" };
  private volumes: StemVolumes = { ...FULL_VOLUMES };
  private muted: StemFlags = { ...ZERO_FLAGS };
  private soloed: StemFlags = { ...ZERO_FLAGS };
  private masterVolume = 1;
  private tempo = 1.0;

  constructor(ctx: AudioContext, stretcherFactory: StretcherFactory) {
    this.ctx = ctx;
    this.stretcherFactory = stretcherFactory;
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
      if (!this.stretchers[name]) {
        const s = this.stretcherFactory(this.ctx);
        s.tempo.setValueAtTime(this.tempo, this.ctx.currentTime);
        this.stretchers[name] = s;
      }
      if (!this.gains[name]) {
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(
          effectiveGain(this.volumes, this.muted, this.soloed, name),
          this.ctx.currentTime,
        );
        const stretcher = this.stretchers[name]!;
        stretcher.connect(g);
        g.connect(this.master);
        this.gains[name] = g;
      }
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
      src.connect(this.stretchers[name]!);
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
    const offset = currentAudioPos(this.state, this.ctx.currentTime, this.tempo, this.duration);
    this.stopSources();
    this.state = { kind: "paused", offset };
  }

  seek(offset: number): void {
    const target = clamp(offset, 0, this.duration);
    if (this.state.kind === "playing") {
      this.play(target);
    } else {
      this.state = { kind: "paused", offset: target };
    }
  }

  setVolume(stem: StemName, value: number): void {
    this.volumes[stem] = clamp(value, 0, 1);
    this.applyMix();
  }

  setMuted(stem: StemName, on: boolean): void {
    this.muted[stem] = on;
    this.applyMix();
  }

  setSoloed(stem: StemName, on: boolean): void {
    this.soloed[stem] = on;
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

  /**
   * Smooth tempo change. We snapshot the current audio position so
   * getCurrentTime stays continuous across the transition, then ramp
   * each stretcher's `tempo` AudioParam over a short window so the
   * audio doesn't click at the boundary.
   */
  setTempo(value: number): void {
    const next = clamp(value, TEMPO_MIN, TEMPO_MAX);
    const now = this.ctx.currentTime;
    if (this.state.kind === "playing") {
      const audioPos = currentAudioPos(this.state, now, this.tempo, this.duration);
      this.state = {
        kind: "playing",
        ctxStartTime: now,
        offsetAtStart: audioPos,
      };
    }
    this.tempo = next;
    for (const name of STEM_NAMES) {
      const s = this.stretchers[name];
      if (!s) continue;
      s.tempo.cancelScheduledValues(now);
      s.tempo.setValueAtTime(s.tempo.value, now);
      s.tempo.linearRampToValueAtTime(next, now + RAMP_SECONDS);
    }
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

  getMasterVolume(): number {
    return this.masterVolume;
  }

  getTempo(): number {
    return this.tempo;
  }

  getCurrentTime(): number {
    return currentAudioPos(this.state, this.ctx.currentTime, this.tempo, this.duration);
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

  private applyMix(): void {
    const now = this.ctx.currentTime;
    const target = now + RAMP_SECONDS;
    for (const name of STEM_NAMES) {
      const node = this.gains[name];
      if (!node) continue;
      const value = effectiveGain(this.volumes, this.muted, this.soloed, name);
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(value, target);
    }
  }

  private stopSources(): void {
    for (const name of STEM_NAMES) {
      const src = this.sources[name];
      if (src) {
        try {
          src.stop();
        } catch {
          // already stopped
        }
        src.disconnect();
        delete this.sources[name];
      }
    }
  }
}
