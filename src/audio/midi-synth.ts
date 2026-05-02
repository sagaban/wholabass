/**
 * Lightweight bass synth driven by a list of `BassNote`s. Stays in
 * sync with `StemEngine` by scheduling oscillators at AudioContext
 * times computed from the engine's song-time + tempo.
 *
 * No Tone.js — bare Web Audio is plenty for a single triangle voice
 * with an ADSR envelope. The scheduling math is exported as a pure
 * function so it can be unit-tested without Web Audio.
 */

import type { BassNote } from "@/audio/midi";

export interface ScheduledEvent {
  pitch: number;
  /** AudioContext time when the note should start. */
  ctxStart: number;
  /** AudioContext time when the note's body ends (before release). */
  ctxEnd: number;
  /** Peak gain after attack, in 0..1 (already scaled by velocity). */
  peakGain: number;
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
const PEAK_GAIN_SCALE = 0.3;

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
  for (const n of notes) {
    const noteEnd = n.startSec + n.durSec;
    if (noteEnd <= songOffset) continue;
    if (songEnd !== undefined && n.startSec >= songEnd) continue;
    const songStartFromOffset = Math.max(0, n.startSec - songOffset);
    const songEndFromOffset = Math.max(songStartFromOffset, noteEnd - songOffset);
    const evtStart = ctxStart + songStartFromOffset / tempo;
    const evtEnd = ctxStart + songEndFromOffset / tempo;
    const peakGain = PEAK_GAIN_SCALE * Math.max(VELOCITY_FLOOR, Math.min(1, n.velocity));
    out.push({ pitch: n.pitch, ctxStart: evtStart, ctxEnd: evtEnd, peakGain });
  }
  return out;
}

/** Standard MIDI pitch → frequency. */
export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.05;

interface ActiveVoice {
  src: OscillatorNode;
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
      } catch {
        // Already stopped — ignore.
      }
    }
    this.active = [];
  }

  private spawn(evt: ScheduledEvent): void {
    const src = this.ctx.createOscillator();
    src.type = "triangle";
    src.frequency.setValueAtTime(midiToFreq(evt.pitch), evt.ctxStart);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, evt.ctxStart);
    gain.gain.linearRampToValueAtTime(evt.peakGain, evt.ctxStart + ATTACK_SEC);
    const bodyEnd = Math.max(evt.ctxStart + ATTACK_SEC, evt.ctxEnd);
    gain.gain.setValueAtTime(evt.peakGain, bodyEnd);
    gain.gain.linearRampToValueAtTime(0, bodyEnd + RELEASE_SEC);

    src.connect(gain);
    gain.connect(this.master);
    src.start(evt.ctxStart);
    src.stop(bodyEnd + RELEASE_SEC + 0.01);

    const voice: ActiveVoice = { src, gain };
    src.addEventListener(
      "ended",
      () => {
        try {
          src.disconnect();
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
