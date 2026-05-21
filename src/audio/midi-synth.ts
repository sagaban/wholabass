/**
 * Lightweight bass synth driven by a list of `BassNote`s. Stays in
 * sync with `StemEngine` by scheduling oscillators at AudioContext
 * times computed from the engine's song-time + tempo.
 *
 * Per voice we run a sawtooth (overtones) + a sub-octave sine (body)
 * through a low-pass filter with a small envelope on the cutoff so
 * each note has a percussive front + warm sustain — closer to a
 * fingered electric bass than the previous bare triangle.
 * The scheduling math is exported as a pure function so it can be
 * unit-tested without Web Audio.
 */

import type { Articulation, BassNote } from "@/audio/midi";

export interface ScheduledEvent {
  pitch: number;
  /** AudioContext time when the note should start. */
  ctxStart: number;
  /** AudioContext time when the note's body ends (before release). */
  ctxEnd: number;
  /** Peak gain after attack, in 0..1 (already scaled by velocity). */
  peakGain: number;
  /** Per-note technique flags forwarded by the synth's `spawn()`. */
  articulation?: Articulation;
  /**
   * If set, glide src/sub frequency from `pitch` to `slideToPitch` over
   * the span [ctxStart, slideEndCtx]. `ctxEnd` is extended to at least
   * `slideEndCtx` so the gliding tone keeps ringing into the next note.
   */
  slideToPitch?: number;
  slideEndCtx?: number;
  /**
   * Previous note carried a `legato` flag — skip this note's attack so
   * it plays straight into the peak gain (hammer-on / pull-off).
   */
  suppressAttack?: boolean;
}

export interface ScheduleParams {
  /** Song-time at which playback begins (seconds). */
  songOffset: number;
  /** AudioContext time corresponding to `songOffset`. */
  ctxStart: number;
  /** Engine tempo. tempo<1 → notes get stretched in real time. */
  tempo: number;
  /** Optional: stop scheduling notes whose start ≥ this song-time. */
  songEnd?: number;
}

const VELOCITY_FLOOR = 0.2;
// The synth output is summed alongside the four stems; bumping the
// per-voice peak from the previous 0.3 to 0.7 lands roughly at parity
// with a typical pop-mix bass stem so the user can actually hear it
// at default mixer settings.
const PEAK_GAIN_SCALE = 0.7;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure: convert song-time-domain notes into AudioContext-time events
 * relative to a scheduling origin. Notes that have already finished
 * before `songOffset` are skipped; partial notes (started before, end
 * after) are clipped to start at `ctxStart`.
 */
export function notesToSchedule(
  notes: readonly BassNote[],
  params: ScheduleParams,
): ScheduledEvent[] {
  const { songOffset, ctxStart, tempo, songEnd } = params;
  if (tempo <= 0) return [];
  const out: ScheduledEvent[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const noteEnd = n.startSec + n.durSec;
    if (noteEnd <= songOffset) continue;
    if (songEnd !== undefined && n.startSec >= songEnd) continue;
    const songStartFromOffset = Math.max(0, n.startSec - songOffset);
    const songEndFromOffset = Math.max(songStartFromOffset, noteEnd - songOffset);
    const evtStart = ctxStart + songStartFromOffset / tempo;
    const evtEnd = ctxStart + songEndFromOffset / tempo;
    // Articulation-driven gain + duration scaling. Ghost is very quiet
    // and brief; accent boosts; staccato truncates the body. palmMute
    // also shortens the body (and the spawn() side dulls the tone).
    const a = n.articulation;
    let gainMul = 1;
    if (a?.ghost) gainMul *= 0.3;
    if (a?.accent) gainMul *= 1.4;
    const peakGain = PEAK_GAIN_SCALE * Math.max(VELOCITY_FLOOR, Math.min(1, n.velocity)) * gainMul;
    let scaledEnd = evtEnd;
    if (a?.staccato) {
      scaledEnd = evtStart + (evtEnd - evtStart) * 0.3;
    } else if (a?.palmMute) {
      const body = evtEnd - evtStart;
      scaledEnd = evtStart + Math.min(body, 0.2 / tempo);
    } else if (a?.ghost) {
      scaledEnd = evtStart + Math.min(evtEnd - evtStart, 0.12 / tempo);
    }
    // Harmonics are nominally an octave up — easy way to get the bright
    // "bell" tone without needing fret-position-specific math.
    const pitch = a?.harmonic ? n.pitch + 12 : n.pitch;

    // Slide: glide src/sub frequency into the *next* note's pitch over
    // the gap between them. Extend ctxEnd so the gliding tone keeps
    // ringing into the next note's start (a tiny overlap is intentional).
    const next = notes[i + 1];
    let slideToPitch: number | undefined;
    let slideEndCtx: number | undefined;
    let finalEnd = scaledEnd;
    if (a?.slide && next) {
      const nextStartFromOffset = Math.max(0, next.startSec - songOffset);
      const nextStartCtx = ctxStart + nextStartFromOffset / tempo;
      slideToPitch = next.articulation?.harmonic ? next.pitch + 12 : next.pitch;
      slideEndCtx = nextStartCtx;
      finalEnd = Math.max(finalEnd, nextStartCtx);
    }

    // Legato: previous note carries the flag; we (the next note) suppress
    // our own attack so it sounds like one continuous tone.
    const prev = notes[i - 1];
    const suppressAttack = !!prev?.articulation?.legato;

    out.push({
      pitch,
      ctxStart: evtStart,
      ctxEnd: finalEnd,
      peakGain,
      ...(a ? { articulation: a } : {}),
      ...(slideToPitch !== undefined ? { slideToPitch, slideEndCtx } : {}),
      ...(suppressAttack ? { suppressAttack: true } : {}),
    });
  }
  return out;
}

/** Standard MIDI pitch → frequency. */
export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.06;
// Filter cutoff envelope: starts open for the percussive attack, decays
// quickly to the body cutoff so sustained notes stay warm and not harsh.
const FILTER_ATTACK_HZ = 2400;
const FILTER_BODY_HZ = 600;
const FILTER_DECAY_SEC = 0.12;
const FILTER_Q = 4;
const SUB_GAIN_SCALE = 0.6;

interface ActiveVoice {
  src: OscillatorNode;
  sub: OscillatorNode;
  gain: GainNode;
}

export class MidiSynth {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private notes: readonly BassNote[] = [];
  private active: ActiveVoice[] = [];
  private masterVolume = 0.8;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.setValueAtTime(this.masterVolume, ctx.currentTime);
    this.master.connect(ctx.destination);
  }

  setNotes(notes: readonly BassNote[]): void {
    this.notes = notes;
    this.cancel();
  }

  setMasterVolume(value: number): void {
    const clamped = clamp(value, 0, 1);
    this.masterVolume = clamped;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(clamped, now + 0.01);
  }

  /**
   * Schedule every remaining note from `songOffset` onward. Cancels any
   * previously scheduled voices first, so this is safe to call from
   * play/seek/tempo-change/loop-jump callbacks.
   */
  schedule(songOffset: number, tempo: number, songEnd?: number): void {
    this.cancel();
    const events = notesToSchedule(this.notes, {
      songOffset,
      ctxStart: this.ctx.currentTime,
      tempo,
      songEnd,
    });
    for (const evt of events) {
      this.spawn(evt);
    }
  }

  cancel(): void {
    const now = this.ctx.currentTime;
    for (const v of this.active) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + ATTACK_SEC);
        v.src.stop(now + ATTACK_SEC + 0.001);
        v.sub.stop(now + ATTACK_SEC + 0.001);
      } catch {
        // Already stopped — ignore.
      }
    }
    this.active = [];
  }

  private spawn(evt: ScheduledEvent): void {
    const a = evt.articulation;
    const freq = midiToFreq(evt.pitch);
    const subFreq = midiToFreq(evt.pitch - 12);

    // Main oscillator. Harmonics swap the sawtooth for a sine to get the
    // bell-like timbre; the +12 semitone shift is already in evt.pitch.
    const src = this.ctx.createOscillator();
    src.type = a?.harmonic ? "sine" : "sawtooth";
    src.frequency.setValueAtTime(freq, evt.ctxStart);

    // Sub oscillator — sine an octave down for thickness. Muted for
    // harmonics (the whole point is a thin, glassy tone).
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(subFreq, evt.ctxStart);

    // Slide: linearly ramp both oscillators to the next note's pitch
    // over the gap so the listener hears one continuous glide.
    if (evt.slideToPitch !== undefined && evt.slideEndCtx !== undefined) {
      const targetFreq = midiToFreq(evt.slideToPitch);
      const targetSubFreq = midiToFreq(evt.slideToPitch - 12);
      src.frequency.linearRampToValueAtTime(targetFreq, evt.slideEndCtx);
      sub.frequency.linearRampToValueAtTime(targetSubFreq, evt.slideEndCtx);
    }

    // Bend: ramp up by `semitones` over the first ⅓ of the body, hold,
    // and optionally release back over the last ⅓.
    if (a?.bend) {
      const body = Math.max(0.05, evt.ctxEnd - evt.ctxStart);
      const bendFreq = freq * Math.pow(2, a.bend.semitones / 12);
      const bendSubFreq = subFreq * Math.pow(2, a.bend.semitones / 12);
      const peakTime = evt.ctxStart + body / 3;
      src.frequency.linearRampToValueAtTime(bendFreq, peakTime);
      sub.frequency.linearRampToValueAtTime(bendSubFreq, peakTime);
      if (a.bend.release) {
        const releaseStart = evt.ctxEnd - body / 3;
        src.frequency.setValueAtTime(bendFreq, releaseStart);
        sub.frequency.setValueAtTime(bendSubFreq, releaseStart);
        src.frequency.linearRampToValueAtTime(freq, evt.ctxEnd);
        sub.frequency.linearRampToValueAtTime(subFreq, evt.ctxEnd);
      }
    }
    const subGain = this.ctx.createGain();
    const subLevel = a?.harmonic ? 0 : a?.palmMute ? SUB_GAIN_SCALE * 0.5 : SUB_GAIN_SCALE;
    subGain.gain.setValueAtTime(subLevel, evt.ctxStart);

    // Lowpass with a percussive attack on cutoff — closed-mouth at the
    // start, decays quickly to a warm body level for sustained notes.
    // Palm-mute halves both cutoffs so the body sits darker; the user's
    // fret hand is "choking" the strings, after all.
    const muteScale = a?.palmMute ? 0.5 : 1;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.setValueAtTime(FILTER_Q, evt.ctxStart);
    filter.frequency.setValueAtTime(FILTER_ATTACK_HZ * muteScale, evt.ctxStart);
    filter.frequency.exponentialRampToValueAtTime(
      FILTER_BODY_HZ * muteScale,
      evt.ctxStart + FILTER_DECAY_SEC,
    );

    // Amplitude envelope: short attack → peak → small decay to a 70%
    // sustain → release on note end. linearRampToValueAtTime can't ramp
    // to 0, so the release uses setTargetAtTime via two ramps instead.
    // Legato (hammer-on / pull-off into this note): skip the attack so
    // the previous tone flows in without a re-pluck.
    const gain = this.ctx.createGain();
    const peak = evt.peakGain;
    const sustain = peak * 0.7;
    const bodyEnd = Math.max(evt.ctxStart + ATTACK_SEC + 0.05, evt.ctxEnd);
    if (evt.suppressAttack) {
      gain.gain.setValueAtTime(sustain, evt.ctxStart);
    } else {
      gain.gain.setValueAtTime(0, evt.ctxStart);
      gain.gain.linearRampToValueAtTime(peak, evt.ctxStart + ATTACK_SEC);
      gain.gain.linearRampToValueAtTime(sustain, evt.ctxStart + ATTACK_SEC + 0.08);
    }
    gain.gain.setValueAtTime(sustain, bodyEnd);
    gain.gain.linearRampToValueAtTime(0, bodyEnd + RELEASE_SEC);

    // Vibrato: a 6 Hz sine LFO driving src.detune by 30 cents adds the
    // characteristic pitch wobble. Routed through detune (not frequency)
    // so it composes cleanly with any frequency ramps from slide/bend.
    let lfo: OscillatorNode | undefined;
    if (a?.vibrato) {
      lfo = this.ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.setValueAtTime(6, evt.ctxStart);
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.setValueAtTime(30, evt.ctxStart);
      lfo.connect(lfoGain).connect(src.detune);
      lfoGain.connect(sub.detune);
    }

    src.connect(filter);
    sub.connect(subGain).connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    src.start(evt.ctxStart);
    sub.start(evt.ctxStart);
    const stopAt = bodyEnd + RELEASE_SEC + 0.01;
    src.stop(stopAt);
    sub.stop(stopAt);
    if (lfo) {
      lfo.start(evt.ctxStart);
      lfo.stop(stopAt);
    }

    const voice: ActiveVoice = { src, sub, gain };
    src.addEventListener(
      "ended",
      () => {
        try {
          src.disconnect();
          sub.disconnect();
          subGain.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch {
          // Already disconnected.
        }
        const idx = this.active.indexOf(voice);
        if (idx >= 0) this.active.splice(idx, 1);
      },
      { once: true },
    );
    this.active.push(voice);
  }
}
