# 🚩 MVP Checkpoint — Phase 1 critical path complete

T0–T8 verified end-to-end. The app does the thing it was built to do:
ingest a song (file or YouTube URL), separate into 4 stems, transcribe
the bass to MIDI, and play it back with synced multi-stem audio,
per-stem mixer, master volume, scrolling piano-roll, pitch-preserving
slow-down, and A-B looping.

## What we shipped

| Slice | Notes |
| --- | --- |
| T0 | Tauri 2 + React 19 + TS + Python sidecar (uv) scaffold; JSON-RPC ping. |
| T1 | Local file → 4 Demucs stems on disk; meta.json. |
| T2 | Multi-stem playback, master transport (play/pause/seek). |
| T3 | Per-stem volume, mute/solo, master volume. |
| T4 | Cache short-circuit on `processing_version` + on-disk stems/midi. |
| T5 | YouTube URL ingest via yt-dlp; canonical URL strips `&list=…`. |
| T6 | basic-pitch bass MIDI; piano-roll Canvas synced to playhead. |
| T7 | Pitch-preserving 50–100% slow-down via SoundTouch AudioWorklet. |
| T8 | A-B loop with independent Set A / Set B markers + seek-bar marks. |

Plus polish picked up along the way:
- **T9 (basic)** — library list with Delete (Park Dialog confirmation) and Retry on partial entries (resumes from the missing step).
- **T10** — real yt-dlp percentages, monotonic stage-mapped progress bar, Cancel that respawns the sidecar and wipes the partial library entry.
- Theme: Park UI (Panda CSS) with iris→indigo accent and a light/dark toggle.
- Routing: TanStack Router with two screens (Library / Player).
- Tooling: oxlint + oxfmt replacing ESLint + Prettier.
- Robust IPC: sidecar reserves a private fd for JSON-RPC and routes all stdout to stderr so third-party prints (yt-dlp, basic-pitch, coremltools) can't corrupt the protocol.

## Acceptance vs. SPEC §3

| Criterion | Status |
| --- | --- |
| 4-min YouTube → end-to-end < 3 min on M-series CPU | Manually verified. |
| Cached song re-opens < 2 s | Verified (cache short-circuit). |
| Stems sync within ±20 ms | SoundTouch worklet gives sample-aligned chains. |
| Per-stem volume slider has no audible glitches | Confirmed (10 ms ramp). |
| A-B loop tight across 20+ iterations | Each iteration restarts from A; no drift. |
| Time-stretch at 50% has no perceptible pitch shift | SoundTouch tempo is pitch-independent. |
| Piano-roll smooth + locked to playhead | rAF-driven, reads `engine.getCurrentTime`. |
| Long-running stages report progress; Cancel works cleanly | Yes; cancel respawns sidecar + cleans partial. |
| First-run "downloading models (~500 MB)" UX | **Not yet** — see T11. |

## Decisions / Observations

- **Time-stretch quality**: Chromium's native `preservesPitch` was glitchy on percussive material; we swapped to `@soundtouchjs/audio-worklet`. Sounds clean at 50%. SPEC §10 had this as the open question and we've decided.
- **Bass piano-roll accuracy**: useful as a visual cue. basic-pitch on a separated bass stem gets the major notes; minor pitch errors don't affect practice value.
- **Song-management delay**: there's a perceptible delay opening / managing songs (probably stem decode + AudioWorklet registration on the player route). Logged but accepted for now.

## What's left (polish, parallelizable)

- **T11** — First-run model setup (Demucs + basic-pitch weights download UX).
- **T12** — Smoke test + lint/format CI (the lint/format part already exists locally).
- **T9 polish** — sidebar with sort, processed-at timestamps, etc.
- **Song-management delay** — investigate (likely first-call AudioWorklet registration cost, decode time).
