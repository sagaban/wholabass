# Phase 1 Implementation Plan

Source: [SPEC.md](../SPEC.md) §2 Phase 1.

Phase 1 goal: ingest a YouTube URL or local audio file, separate into 4 stems, transcribe bass to MIDI, play 4 stems in sync with per-stem volume, show a piano-roll synced to playback, support slow-down and A-B loop. No tabs yet (Phase 2). No tab editing (Phase 3).

---

## Dependency graph

```
T0 scaffold ──┬──> T1 file→stems ──┬──> T2 sync playback ──> T3 mixer
              │                    │
              │                    └──> T4 cache short-circuit
              │                                  │
              │                                  ├──> T5 YouTube ingest
              │                                  │
              │                                  └──> T6 bass MIDI + piano-roll
              │                                              │
              │                                              ├──> T7 time-stretch
              │                                              │
              │                                              └──> T8 A-B loop
              │
              │   ── 🚩 Checkpoint: practice-tool MVP — demo + go/no-go ──
              │
              ├──> T9  library list UI
              ├──> T10 progress + cancellation
              ├──> T11 first-run model setup
              └──> T12 smoke test + lint/format CI
```

T9–T12 depend only on T0; they're parallelizable polish work. The critical path to a usable practice tool is **T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8** (then checkpoint).

---

## Slicing principle

Each task delivers **one complete path through the stack** with a binary verification step. Foundation (T0) and CI/polish (T11–T12) are explicitly non-vertical and called out. Everything in between adds visible end-to-end behaviour.

---

## Tasks

### T0 — Foundation scaffold

**Why:** unblocks every task below. Not vertical, but unavoidable.

Build:

- Tauri 2 + React + TS + Vite app boots and shows a window.
- `ml/` Python project under `uv` with `server.py` doing newline-JSON-RPC over stdio.
- Rust spawns the sidecar on app start, sends a `ping`, displays the response.
- Library helpers in Rust: `app_data_dir()`, `song_id_from_url(url)`, `song_id_from_file(path)`, `PROCESSING_VERSION` constant.
- `.gitignore` for `library/`, `node_modules/`, `target/`, `.venv/`, `dist/`.

**Acceptance:**

- `pnpm tauri dev` opens a window showing `sidecar: ok (<timestamp>)`.
- Closing the window terminates the sidecar process (no zombies).
- Restarting after force-kill cleans up stale sockets/locks (n/a — stdio).

**Verification:**

- `pnpm tauri dev` → manual eyeball.
- `ps -ef | grep python` after window close shows no sidecar.

---

### T1 — Local file → stems on disk

**Why:** first vertical slice. Proves the IPC + Demucs pipeline + library writes.

Build:

- Drag-drop zone in UI; on drop, send file path to Rust.
- Rust: hash → id → `library/<id>/source.wav` (copy/transcode if needed).
- Rust → Python: `separate { id, source_path }`.
- Python: run Demucs `htdemucs`, write 4 wavs to `library/<id>/stems/`, write `meta.json` (title=filename, source.kind="file", source.ref=original path, duration, processing_version, created_at).
- UI shows "ready: <id>" when done.

**Acceptance:**

- Dropping a 30 s mp3 produces `library/<id>/{source.wav, meta.json, stems/{vocals,drums,bass,other}.wav}` within 60 s on M-series.
- Stems are 44.1 kHz stereo wav.

**Verification:**

- Drop a fixture clip, check filesystem with `ls -la`.
- `ffprobe stems/bass.wav` reports valid wav.

---

### T2 — Multi-stem synced playback

**Why:** the core practice feature — hear separated stems together.

Build:

- Audio engine (`src/audio/engine.ts`): one `AudioContext`, 4 `AudioBufferSourceNode`s (one per stem) all started from one scheduled `start(time)`.
- Master transport: play, pause, seek (seek = stop + recreate sources at offset).
- Default to flat mix (all gains = 1.0).

**Acceptance:**

- After T1 finishes, "Play" button starts all 4 stems synced within ±20 ms (measure with one click track stem if needed; or trust Web Audio spec).
- Seek to 1:30 lands all 4 stems at 1:30.
- Pause + resume continues from the pause point on all 4.

**Verification:**

- Manual listen to a known song; vocals + drums together sound like the original.
- Vitest unit on engine math (offset → start time).

---

### T3 — Stem mixer

**Why:** the actual practice value: turn down bass to play along; solo to listen.

Build:

- 4 vertical sliders + mute/solo buttons.
- Each stem gets a `GainNode` between its source and destination.
- Solo behaviour: solo any stem(s) → all non-solo gains forced to 0.
- Volume changes use `gain.linearRampToValueAtTime` (no zipper noise).

**Acceptance:**

- Move bass slider to 0 → bass disappears, others unchanged.
- Solo bass → only bass audible; click solo again → mix returns.
- Live-dragging the slider has no clicks.

**Verification:**

- Manual A/B listen.
- React Testing Library: solo button toggles class + posts gain commands.

---

### T4 — Cache short-circuit

**Why:** processing is slow; must not redo it.

Build:

- On ingest, before calling Python: check `library/<id>/meta.json` exists, `processing_version` matches, all 4 stems + (later) `bass.mid` exist.
- If yes: skip pipeline, jump straight to load.
- If `processing_version` differs: reprocess.

**Acceptance:**

- Drop the same file twice in one session — 2nd time playable in <2 s.
- Bumping `PROCESSING_VERSION` in code triggers reprocess on next ingest.

**Verification:**

- Manual; log "cache hit" / "cache miss" in console during dev.
- Rust unit test on `library::is_ready(id)`.

---

### T5 — YouTube URL ingest

**Why:** the headline use case.

Build:

- URL input field; on submit: Rust validates URL, computes id from YouTube video id, calls Python `download { id, url }`.
- Python: `yt-dlp` to `library/<id>/source.wav` (audio-only, wav).
- Then flow into existing T1 separate step (which T4 may short-circuit).

**Acceptance:**

- Paste a known YouTube URL → song appears in library and plays after pipeline.
- Same URL pasted twice → 2nd is fast (T4 short-circuits at the `meta.json` check; no re-download).
- Invalid URL → user-visible error, no half-written `library/<id>/`.

**Verification:**

- Manual: process one short YouTube video.
- Rust unit test: `song_id_from_url("https://youtube.com/watch?v=ABC")` is stable.

---

### T6 — Bass MIDI + piano-roll

**Why:** see what the bass is doing while you hear it.

Build:

- Python: after separation, run `basic-pitch` on `bass.wav` → `library/<id>/bass.mid`. Add to cache-ready check (T4).
- TS MIDI parser (use `@tonejs/midi` or roll a tiny one) → array of `{pitch, startSec, durSec, velocity}`.
- `PianoRoll.tsx`: Canvas component, scrolling horizontally with the playhead, vertical axis = pitch within bass range (E1–G4), notes rendered as rectangles.
- Updates from `requestAnimationFrame`, reads current time from the audio engine.

**Acceptance:**

- After processing, piano-roll shows notes; visually they line up with audible bass entrances.
- During playback, the playhead line advances and stays within ±1 frame of audio time.
- After seek, piano-roll jumps and re-aligns.

**Verification:**

- Manual on a song with a clearly audible bassline.
- Vitest on MIDI parser fixture.

---

### T7 — Time-stretch (slow-down)

**Why:** practice at 50% then ramp up.

Build:

- Replace direct `AudioBufferSourceNode → destination` with a `rubberband-wasm` (or `soundtouch-js`) processor node per stem.
- Tempo control: 50%–100% slider; 100% bypasses processor for zero-overhead default.
- Pitch is preserved.

**Acceptance:**

- 50% slider → audio is half-speed, pitch unchanged.
- Switching back to 100% has no audible glitch.
- Stems stay synced under any tempo (±20 ms).

**Verification:**

- Manual: slow down a song with a recognizable melody; verify pitch unchanged.
- Decision point: if Rubberband-wasm bundle is unwieldy or licensing blocks dev, fall back to SoundTouch-js (logged in SPEC §10).

---

### T8 — A-B loop

**Why:** drill a passage until it's clean.

Build:

- Two markers: A and B (set via "Set A at current time", same for B).
- Loop region: when playhead reaches B, jump back to A by re-scheduling all sources from offset A.
- Visual indicators on a timeline / piano-roll.

**Acceptance:**

- Set A at 0:30, B at 0:34 → loop plays 0:30–0:34 indefinitely.
- 20 loop iterations → still tight at the boundary, no drift, no audible gap.
- Loop persists across volume/tempo changes.

**Verification:**

- Manual stress test: 20+ iterations.
- Vitest on the loop scheduler boundary math.

---

### 🚩 Checkpoint — Practice-tool MVP

After T8, the app does the thing it exists to do. **Stop and demo before T9–T12.** Decide:

- Is the bass piano-roll accurate enough to be useful?
- Is time-stretch quality acceptable?
- Are there missing knobs that should jump ahead of T9–T12 polish?

Record decisions in `tasks/checkpoint.md` (created at the time, not now).

---

### T9 — Library list UI

**Why:** without this, every session starts from scratch.

Build:

- SQLite-backed (or just a `library/index.json` if SQLite feels heavy) list of processed songs.
- Sidebar component: title, source kind, duration, processed-at. Click to load.
- Delete affordance (with confirmation) — removes `library/<id>/` and DB row.

**Acceptance:**

- Process 3 songs → all 3 in sidebar.
- Click any → app loads it.
- Delete → directory and row gone.

---

### T10 — Progress + cancellation

**Why:** UX for long tasks; ability to abort.

Build:

- Python: emit `{progress, stage}` events during download / separate / transcribe (Demucs has a callback; basic-pitch chunk by chunk; yt-dlp via progress hook).
- Rust: forward to frontend via Tauri events.
- UI: progress bar with stage label.
- Cancel button: send `cancel { target_id }` to Python; Python's worker checks a cancel flag between chunks; result returns an error with `code: "cancelled"`.

**Acceptance:**

- Progress bar visibly advances during separation.
- Clicking cancel mid-Demucs stops the run; `library/<id>/` is left in a half-state but `meta.json` is **not** written, so cache check correctly says "not ready".

---

### T11 — First-run model setup

**Why:** Demucs and basic-pitch weights are big; user shouldn't see a silent stall.

Build:

- On first ingest, Python checks model cache; if missing, downloads and emits progress.
- UI shows a one-time "Downloading models (~500 MB)" panel.
- On subsequent runs, no UI; weights are cached.

**Acceptance:**

- Fresh install → first ingest shows download UI, blocks ingest until done.
- Second run on same machine → no download UI.

---

### T12 — Smoke test + lint/format

**Why:** safety net before further phases.

Build:

- `ml/tests/fixtures/clip.wav`: a ~5 s royalty-free clip (or one I record).
- `make smoke`: runs the full pipeline on the fixture and asserts artifacts on disk.
- Add `pnpm lint`, `pnpm fmt`, `cd src-tauri && cargo clippy -- -D warnings`, `cd ml && uv run ruff check && uv run mypy --strict pipeline`.

**Acceptance:**

- `make smoke` passes locally on a clean checkout.
- `pnpm lint` clean.
- All three language linters wired into a single `make check` target.

---

## Risks

| Risk                                   | Mitigation                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demucs CPU latency on long tracks      | Show progress; ship MPS path on macOS; document expected times in README.                                                                                             |
| `basic-pitch` accuracy on bass         | Acceptance only requires "visibly tracks audible bass" in T6. Bad transcription is fine for piano-roll display; tab generation in Phase 2 is where it really matters. |
| Web Audio sync drift across stems      | Use one shared `AudioContext` and one scheduled `start(time)`; verify ±20 ms with a click stem.                                                                       |
| Rubberband-wasm bundle / licensing     | Fallback to SoundTouch-js at T7.                                                                                                                                      |
| `yt-dlp` breakage from YouTube changes | Pin a recent version; update via `uv` when needed.                                                                                                                    |
| `processing_version` migrations        | All-or-nothing reprocess on bump; documented in SPEC §5.                                                                                                              |

---

## Out of scope (do not start)

- 5-string / drop tunings.
- Export (PDF/MIDI/GP5/MusicXML).
- Auto-update, code signing, distribution.
- Telemetry of any kind.

---

# Phase 2 Implementation Plan

After the 🚩 MVP checkpoint. Decisions per SPEC §2 Phase 2:

- Tempo + bar grid: sidecar `librosa.beat.beat_track`, persisted as
  `library/<id>/beats.json`, added to cache-readiness.
- MIDI playback: ships now (alongside audio).
- Section / chord / repeat labels: skipped — Phase 3.
- Layout: single screen — narrower transport on the left, Tab on the right.

## Phase 2 dependency graph

```
T13 beats sidecar ──┬──> T14 fingering optimiser ──> T15 SVG tab renderer
                    │                                       │
                    │                                       └──> T16 split layout (Player ↔ Tab)
                    │
                    └──> T17 MIDI playback (Tone.js) — depends on T13 only
                                       │
                                       └──> T18 rhythm notation polish (beams, ties)
```

T17 can land in parallel with T15/T16 once T13 is in.

---

### T13 — Beat / tempo sidecar + cache integration

**Why:** the tab grid needs tempo + per-beat times. Without it the tab is a flat list of notes.

Build:

- `ml/pipeline/beats.py` with `track_beats(source_path) -> {tempo_bpm: float, beats: [seconds]}` using `librosa.beat.beat_track`. `_run_librosa` is the test seam.
- `server.py`: register `beats` handler.
- `run_separate` in Rust chains a `beats` call after `transcribe`, writing `library/<id>/beats.json`.
- `library::is_ready` requires `beats.json`; bump `PROCESSING_VERSION` (1 → 2 already; → 3 here).
- New Tauri command `read_beats(song_id) -> {tempo_bpm, beats}`.

**Acceptance:**

- Re-process a known song → `beats.json` lands on disk with a sane tempo (e.g., a 120-BPM track reports 115–125).
- Older entries are flagged stale on the library list and Retry resumes from `beats` only when stems + midi already exist.

---

### T14 — Fingering optimizer (TS)

**Why:** every MIDI note has 5+ valid `(string, fret)` placements; we need to pick the playable one.

Build:

- `src/tab/optimizer.ts`. Inputs: `BassNote[]`, `{tuning, octaveShift, maxFret, stringBias}`. Output: `TabNote[]` (`{pitch, startSec, durSec, string, fret}`).
- DP over notes: state = current hand position (lowest fret of last placement), transition cost = `|fret - prevFret| + stringSwitchPenalty + distFromPreferredRegion`. Default tuning `[E1, A1, D2, G2]`.
- Pure module (no React); vitest covers a handful of synthetic riffs with known optimal placements.

**Acceptance:**

- Synthetic ascending E-string scale → all on E.
- Octave jumps → optimizer picks the closer string when one is available.
- Re-running with a different `octaveShift` re-fingers in <100 ms for a 4-min song.

---

### T15 — Tab SVG renderer

**Why:** the practice value is the visual tab.

Build:

- `src/tab/render.ts`: pure layout helpers (note → x/y in SVG units).
- `src/components/Tab.tsx`: SVG with 4 horizontal lines (g/D/A/E top→bottom), bar lines from `beats.json`, fret numbers on the appropriate line, simple rhythm beams below, playhead line driven by `engine.getCurrentTime()`.
- For now: bar numbers only. No section labels, no repeat brackets (Phase 3).
- Auto-scrolls to keep the playhead visible.

**Acceptance:**

- A processed song shows a tab that visually lines up with audible bass entrances.
- Playhead stays within ±1 frame of `engine.getCurrentTime()` during playback and after seek.
- Re-rendering after a parameter slider change is <100 ms.

---

### T16 — Split layout (Player ↔ Tab)

**Why:** the tab needs real estate and shouldn't compete with the transport.

Build:

- PlayerScreen swaps to a 2-column layout: narrow left (transport, tempo, A-B, mixer, sidecar status) + wide right (Tab).
- The piano-roll moves into a hidden "Debug" toggle (kept for now; deletable later).
- Container max-width relaxes; `min-width` on the tab side so the SVG never clips.

**Acceptance:**

- 1100 × 720 (default Tauri window) shows transport + tab without horizontal scroll.
- Resizing the window keeps both panes visible down to ~900 px wide.

---

### T17 — MIDI playback (Tone.js soft-synth)

**Why:** hear what the transcription thinks the bassline is, in isolation, at any tempo.

Build:

- `src/audio/midi-synth.ts`: thin wrapper around `Tone.MonoSynth` (or a sample-based `Sampler` with a single bass sample) driven by `BassNote[]`.
- New transport mode: _Audio_ / _MIDI_ / _Both_. The synth plays in lockstep with `StemEngine.getCurrentTime`; tempo slider scales playback rate (no DSP needed — `Tone.Transport.bpm` or per-note schedule).
- Respects A-B loop via `tickLoop`.

**Acceptance:**

- _MIDI_ mode plays a recognizable bassline through speakers without any audio stems active.
- _Both_ mode keeps the synth in sync with the audio stems within ±50 ms across 30 s of playback.
- Tempo at 50% slows both audio + synth together.

---

### T18 — Rhythm notation + bar polish

**Why:** the reference image needs eighth-note beams, ties, dotted notes — not just naked fret numbers.

Build:

- Beam consecutive ≤8th-notes within a beat.
- Tie notes that span a beat boundary.
- Time-signature header + tempo header (`♩ = 120` from `beats.json`).

**Acceptance:**

- A simple riff renders with the correct beaming pattern at 120 BPM.
- The "Intro / Riff A / 3×" annotations from the reference image are explicitly **deferred** to Phase 3.

---

# Phase 3 Implementation Plan

### T19 — Click-to-edit per-note popover

Click any tab note → Park `Popover` with: alternate `(string, fret)` choices for that pitch (the optimizer already enumerated them), octave ± buttons, delete.

### T20 — Edits persistence + overlay rendering

- `library/<id>/bass.tab.edits.json`: list of `{noteId, kind: "replace"|"delete"|"add", ...}`. Note ids derived from MIDI ordering + start time so they survive optimizer re-runs.
- Render = optimizer output + edits applied last.
- Re-running the optimizer keeps edits whose note still exists.

### T21 — Add note + section labels + repeats

- Click empty space at a beat → add a note. Pitch from a popover (default to last picked).
- Section labels: name a region between two A-B-C marks. Optional repeat count. These are the _Intro (Riff A) · 3×_ annotations from the reference image.
