# Phase 1 — Todo

See [plan.md](plan.md) for full task descriptions, acceptance criteria, and verification.

## Critical path

- [x] T0  — Foundation scaffold (Tauri + React + TS + Python sidecar + library helpers)
- [x] T1  — Local file → 4 stems on disk (Demucs)
- [ ] T2  — Multi-stem synced playback (Web Audio, master transport)
- [ ] T3  — Stem mixer (volume + mute/solo)
- [ ] T4  — Cache short-circuit (skip pipeline on processed songs)
- [ ] T5  — YouTube URL ingest (yt-dlp)
- [ ] T6  — Bass MIDI + piano-roll (basic-pitch + Canvas)
- [ ] T7  — Time-stretch (Rubberband-wasm or SoundTouch-js)
- [ ] T8  — A-B loop

## 🚩 Checkpoint — practice-tool MVP demo + go/no-go

## Polish (parallelizable, depends only on T0)

- [ ] T9  — Library list UI
- [ ] T10 — Progress + cancellation
- [ ] T11 — First-run model setup
- [ ] T12 — Smoke test + lint/format CI
