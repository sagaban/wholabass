# Phase 1 — Todo

See [plan.md](plan.md) for full task descriptions, acceptance criteria, and verification.

## Critical path

- [x] T0 — Foundation scaffold (Tauri + React + TS + Python sidecar + library helpers)
- [x] T1 — Local file → 4 stems on disk (Demucs)
- [x] T2 — Multi-stem synced playback (Web Audio, master transport)
- [x] T3 — Stem mixer (volume + mute/solo)
- [x] T4 — Cache short-circuit (skip pipeline on processed songs)
- [x] T5 — YouTube URL ingest (yt-dlp)
- [x] T6 — Bass MIDI + piano-roll (basic-pitch + Canvas)
- [x] T7 — Time-stretch (SoundTouch AudioWorklet, pitch-preserving)
- [x] T8 — A-B loop

## 🚩 Checkpoint — practice-tool MVP demo + go/no-go

## Polish (parallelizable, depends only on T0)

- [x] T9 — Library list UI (basic list + delete; sidebar/sort polish later)
- [x] T10 — Progress + cancellation (real yt-dlp %, monotonic stage bar, cancel respawns sidecar + cleans partial)
- [x] T11 — First-run model setup
- [ ] T12 — Smoke test + lint/format CI _(deferred — personal practice app, no distribution)_

# Phase 2 — Tab + MIDI playback

See [plan.md](plan.md#phase-2-implementation-plan) for full task descriptions.

## Critical path

- [x] T13 — Beat / tempo sidecar (`librosa.beat.beat_track`) + `beats.json` cache
- [x] T14 — Fingering optimizer (TS, DP over `(string, fret)`)
- [x] T15 — Tab SVG renderer
- [x] T16 — Split layout (narrow Player ↔ Tab side-by-side)
- [x] T17 — MIDI playback via Tone.js soft-synth (shipped as a 5th mixer track, not a mode toggle)
- [x] T18 — Rhythm notation polish (duration classification + beams, ties deferred)

# Phase 3 — Editable tabs

- [x] T19 — Click-to-edit per-note popover
- [x] T20 — Edits persistence + overlay rendering
- [x] T21 — Add notes + section labels + repeats
