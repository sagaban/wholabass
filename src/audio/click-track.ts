import { log } from "@/diag/logger";

// Drummer-style count-in: schedule a handful of short clicks at the
// local beat interval, then call `onComplete` so the caller can start
// playback in lock-step with the next downbeat. The clicks are routed
// straight to `ctx.destination` (separate from the song mix) so master
// volume / mute states don't accidentally swallow them.
//
// We honour the song's actual beat track when available — the interval
// is the average gap between the few beats leading up to the play
// position, so a tempo-mapped song still counts in correctly. When
// beats.json is missing or the play position is outside its range we
// fall back to the song-average BPM.

export interface CountInOptions {
  ctx: AudioContext;
  /** beats.json times, in seconds. May be empty. */
  beats: readonly number[];
  /** Used when `beats` is empty or doesn't bracket `atSec`. */
  fallbackBpm: number;
  /** How many clicks to play. Caller is responsible for capping. */
  count: number;
  /** Song-time where playback will resume; used to pick the local tempo. */
  atSec: number;
  onComplete: () => void;
}

export interface CountInHandle {
  cancel: () => void;
}

export function startCountIn(opts: CountInOptions): CountInHandle {
  const { ctx, beats, fallbackBpm, count, atSec, onComplete } = opts;
  const interval = localBeatInterval(beats, atSec) ?? 60 / Math.max(1, fallbackBpm);
  log.debug(
    `countIn.start · beats=${count} interval=${interval.toFixed(3)}s @ ${atSec.toFixed(3)}s (beats.length=${beats.length})`,
  );

  // Small lookahead so the first oscillator's `start(when)` lands in
  // the future — required for sample-accurate scheduling.
  const t0 = ctx.currentTime + 0.05;
  const oscillators: OscillatorNode[] = [];
  for (let i = 0; i < count; i++) {
    const at = t0 + i * interval;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // Square at ~1.5/1k Hz gives a sharp, audible "tick"; first beat
    // is accented so the user hears "1, 2, 3, 4" not "tick tick tick".
    osc.type = "square";
    osc.frequency.value = i === 0 ? 1500 : 1000;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.003);
    gain.gain.linearRampToValueAtTime(0, at + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.07);
    oscillators.push(osc);
  }

  // Resolve at the *next* beat boundary (i.e. one interval past the
  // last click) — that's where the band would actually come in.
  const endAt = t0 + count * interval;
  const ms = Math.max(0, (endAt - ctx.currentTime) * 1000);
  let cancelled = false;
  const timer = setTimeout(() => {
    if (!cancelled) onComplete();
  }, ms);

  return {
    cancel: () => {
      cancelled = true;
      log.debug("countIn.cancel");
      clearTimeout(timer);
      for (const o of oscillators) {
        try {
          o.stop();
        } catch {
          // Already stopped or never started — ignore.
        }
      }
    },
  };
}

/**
 * Average the few beat intervals around `at` so a tempo-mapped song's
 * count-in matches what's about to play. Returns null when we don't
 * have enough beats to span the window.
 */
function localBeatInterval(beats: readonly number[], at: number): number | null {
  if (beats.length < 2) return null;
  // Index of the latest beat at-or-before `at`.
  let i = 0;
  while (i + 1 < beats.length && beats[i + 1] <= at) i++;
  const window = 4;
  const lo = Math.max(0, i - window + 1);
  const hi = Math.min(beats.length - 1, lo + window);
  if (hi - lo < 1) return null;
  return (beats[hi] - beats[lo]) / (hi - lo);
}
