/**
 * Multi-stem synced playback with pitch-preserving time-stretch.
 *
 * Each stem is an HTMLAudioElement piped through MediaElementAudioSourceNode
 * → GainNode → masterGain → destination. We use the element's playbackRate
 * (with preservesPitch = true) to slow down without shifting pitch — Chromium
 * webviews honour this. All four elements share the same currentTime + rate
 * so they stay sample-frame-aligned within typical media-element jitter
 * (~10 ms in practice, well inside the spec's ±20 ms budget).
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export const STEM_NAMES: readonly StemName[] = ["vocals", "drums", "bass", "other"] as const;

export type StemUrls = Record<StemName, string>;

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

export class StemEngine {
  private readonly ctx: AudioContext;
  private audios: Partial<Record<StemName, HTMLAudioElement>> = {};
  private sources: Partial<Record<StemName, MediaElementAudioSourceNode>> = {};
  private gains: Partial<Record<StemName, GainNode>> = {};
  private master: GainNode | null = null;
  private hasLoaded = false;
  private volumes: StemVolumes = { ...FULL_VOLUMES };
  private muted: StemFlags = { ...ZERO_FLAGS };
  private soloed: StemFlags = { ...ZERO_FLAGS };
  private masterVolume = 1;
  private tempo = 1.0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  /**
   * Wire up four HTMLAudioElements with the supplied URLs (typically blob
   * URLs from the loaded stem WAVs). Idempotent: re-binding existing
   * elements just swaps their `src`.
   */
  load(urls: StemUrls): void {
    if (!this.master) {
      const m = this.ctx.createGain();
      m.gain.setValueAtTime(this.masterVolume, this.ctx.currentTime);
      m.connect(this.ctx.destination);
      this.master = m;
    }
    for (const name of STEM_NAMES) {
      let audio = this.audios[name];
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        audio.preservesPitch = true;
        audio.crossOrigin = "anonymous";
        this.audios[name] = audio;
      }
      audio.src = urls[name];
      audio.playbackRate = this.tempo;
      audio.preservesPitch = true;

      let source = this.sources[name];
      if (!source) {
        source = this.ctx.createMediaElementSource(audio);
        this.sources[name] = source;
      }

      let gain = this.gains[name];
      if (!gain) {
        gain = this.ctx.createGain();
        gain.gain.setValueAtTime(
          effectiveGain(this.volumes, this.muted, this.soloed, name),
          this.ctx.currentTime,
        );
        source.connect(gain);
        gain.connect(this.master);
        this.gains[name] = gain;
      }
    }
    this.hasLoaded = true;
  }

  async play(offset?: number): Promise<void> {
    if (!this.hasLoaded) return;
    if (offset !== undefined) this.seek(offset);
    await Promise.all(
      STEM_NAMES.map((n) => this.audios[n]?.play()).filter((p): p is Promise<void> => !!p),
    );
  }

  pause(): void {
    if (!this.hasLoaded) return;
    for (const name of STEM_NAMES) this.audios[name]?.pause();
  }

  seek(offset: number): void {
    if (!this.hasLoaded) return;
    const target = clamp(offset, 0, this.duration);
    for (const name of STEM_NAMES) {
      const a = this.audios[name];
      if (a) a.currentTime = target;
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

  setTempo(value: number): void {
    this.tempo = clamp(value, TEMPO_MIN, TEMPO_MAX);
    for (const name of STEM_NAMES) {
      const a = this.audios[name];
      if (!a) continue;
      a.preservesPitch = true;
      a.playbackRate = this.tempo;
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
    return this.audios.vocals?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.audios.vocals?.duration;
    return Number.isFinite(d) ? (d as number) : 0;
  }

  get isPlaying(): boolean {
    const a = this.audios.vocals;
    return !!a && !a.paused && !a.ended;
  }

  get hasBuffers(): boolean {
    return this.hasLoaded;
  }

  /** Recompute effective gains and ramp every GainNode to its new value. */
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
}
