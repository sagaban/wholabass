# wholabass — Spec

Bass-practice desktop app. Input a YouTube URL or local audio file → split into 4 stems → multi-channel player with per-stem volume → bass piano-roll / tab synced to playback → practice tools (slow-down, A-B loop).

Personal use, single user. Multi-platform (macOS primary; Windows + Linux must work). All ML runs locally.

---

## 1. Objective

- Provide a faster practice loop than "open YouTube, slow it down in VLC, guess the notes."
- Eliminate the round-trip of finding a tab online — generate one from the audio.
- Hear bass in isolation while drums/other still play, at any mix.
- Loop a 4-bar passage at 60% speed without changing pitch until it's clean.

### Non-goals
- No distribution, telemetry, code signing, or auto-update.
- No re-uploading downloaded audio anywhere.
- No social / sharing / community features.
- No support for non-standard tunings or 5/6-string in v1.
- No score export (PDF / GP5 / MusicXML / MIDI download).

---

## 2. Phased scope

### Phase 1 — MVP (the value prop without tabs)
1. Ingest: paste YouTube URL **or** drag-drop local mp3/wav/m4a/flac.
2. Pipeline: download (`yt-dlp`) → separate 4 stems (Demucs `htdemucs`) → transcribe bass stem to MIDI (`basic-pitch`).
3. Library: every processed song persisted on disk; reopening a cached song skips reprocessing.
4. Player: 4 stems play in sync, per-stem volume + mute/solo, master transport (play/pause/seek).
5. Bass view: scrolling **piano-roll** synced to playhead.
6. Practice: time-stretch 50–100% (no pitch shift) + A-B section loop.
7. Progress UI for any task >1 s.

### Phase 2 — Tabs (read-only)
- MIDI → 4-string bass tab via fingering optimizer (string/fret cost minimization, hand-position continuity).
- Read-only scrolling tab view, beat/bar grid, synced to playhead.
- Toggle between piano-roll and tab.

### Phase 3 — Editable tabs
- Click a note → change string/fret, add/delete notes, shift octaves.
- Edits persist to library.
- Re-render tab without re-running ML.

---

## 3. Acceptance criteria (Phase 1)

- A 4-minute YouTube URL processes end-to-end on an M-series Mac in <3 min on CPU, with visible progress per stage.
- A previously processed song opens in <2 s (cache hit).
- 4 stems stay in sync within ±20 ms during continuous playback and after seek.
- Per-stem volume slider has no audible glitches when adjusted live.
- A-B loop restarts cleanly at the loop point (no perceptible gap, no drift across 20 iterations).
- Time-stretch at 50% has no perceptible pitch shift.
- Piano-roll scrolls smoothly with no dropped frames during continuous playback and stays locked to playhead within ±1 frame.
- All long-running pipeline stages report progress; cancelling a job stops the sidecar work cleanly.
- First run shows a one-time "downloading models (~500 MB)" UX before the pipeline starts.

---

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2** | small binaries, Rust IPC, multi-platform |
| Frontend | **React 18 + TypeScript + Vite** | familiar, fast HMR |
| ML sidecar | **Python 3.11**, managed by **uv** | Demucs and basic-pitch are Python-native |
| Download | `yt-dlp` | de-facto standard |
| Separation | `demucs` (`htdemucs` model) | SOTA 4-stem |
| Transcription | `basic-pitch` (Spotify) | best free pitch→MIDI |
| Audio engine | Web Audio API (`AudioBufferSourceNode` per stem) | sample-accurate sync, native |
| Time-stretch | `rubberband-wasm` (preferred) or `soundtouch-js` | pick after prototype |
| Persistence | flat files + **SQLite** (`tauri-plugin-sql`) | metadata index + on-disk artifacts |
| Piano-roll / tab | custom **Canvas** component | full control of scroll/zoom |

### IPC: Rust ↔ Python
Newline-delimited JSON over stdio. Long-running sidecar process reused across calls (model weights stay loaded).

```
→ {"id": "...", "method": "download" | "separate" | "transcribe", "params": {...}}
→ {"id": "...", "method": "cancel", "params": {"target_id": "..."}}
← {"id": "...", "progress": 0..100, "stage": "..."}
← {"id": "...", "result": {...}}                                 // success
← {"id": "...", "error": {"code": "...", "message": "..."}}      // failure or cancelled
```

---

## 5. Project structure

```
wholabass/
├── SPEC.md
├── README.md
├── .gitignore
├── package.json
├── src/                       # React frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── Library.tsx
│   │   ├── Player.tsx
│   │   ├── StemMixer.tsx
│   │   ├── PianoRoll.tsx        # phase 1
│   │   ├── TabView.tsx          # phase 2+
│   │   └── PracticePanel.tsx    # slow-down + A-B loop
│   ├── audio/
│   │   ├── engine.ts            # multi-stem sync, transport
│   │   └── stretch.ts           # time-stretch wrapper
│   ├── hooks/
│   ├── types.ts
│   └── styles/
├── src-tauri/                 # Rust shell
│   ├── src/
│   │   ├── main.rs              # entry, sidecar lifecycle
│   │   ├── commands.rs          # tauri::commands exposed to JS
│   │   ├── library.rs           # SQLite + fs cache
│   │   ├── ipc.rs               # JSON-over-stdio client to Python
│   │   └── ids.rs               # song id from content hash
│   ├── Cargo.toml
│   └── tauri.conf.json
├── ml/                        # Python sidecar
│   ├── pyproject.toml         # uv-managed
│   ├── server.py              # JSON-RPC over stdio main loop
│   ├── pipeline/
│   │   ├── download.py
│   │   ├── separate.py
│   │   └── transcribe.py
│   └── tests/
│       └── fixtures/          # short royalty-free clips
└── library/                   # user data, gitignored
    └── <song-id>/
        ├── meta.json
        ├── source.wav
        ├── stems/
        │   ├── vocals.wav
        │   ├── drums.wav
        │   ├── bass.wav
        │   └── other.wav
        └── bass.mid
```

### Library cache rules
- `<song-id>` = first 12 chars of sha256 over the YouTube video id, or over file content for local files.
- A song is "ready" iff `meta.json` + 4 stems + `bass.mid` all exist for the current `processing_version`.
- If ready, skip pipeline. If `processing_version` mismatches, reprocess.
- `meta.json`: `{title, artist?, source: {kind: "yt"|"file", ref}, duration, processing_version, created_at}`.

---

## 6. Code style

- **TypeScript:** `strict: true`, no `any` (escape via library types only). ESLint + Prettier.
- **React:** function components + hooks. One component per file. PascalCase filenames.
- **Rust:** rustfmt + clippy (warnings fail CI).
- **Python:** `ruff` + `mypy --strict` on `ml/pipeline`.
- **Naming:** PascalCase components, camelCase hooks/utils, snake_case Rust + Python.
- **Comments:** explain WHY only when non-obvious. Don't restate code. No banner comments, no TODOs without an owner+date.
- **Imports:** absolute from `src/` via tsconfig path alias.

---

## 7. Testing strategy

| Layer | Tool | Scope |
|---|---|---|
| TS units | **vitest** | hooks, audio engine math, tab/MIDI helpers |
| React components | **React Testing Library** | mixer + practice panel interactions |
| E2E | **Playwright** | one happy-path: load fixture mp3 → play → A-B loop holds |
| Rust | `cargo test` | `library` cache logic, IPC framing (mock Python) |
| Python | `pytest` | pipeline wrappers on a checked-in <5 s fixture |
| Smoke | `make smoke` | full pipeline on the fixture; runs in CI |

- Don't test the ML models' accuracy — trust upstream. Test that we **call** them correctly and the artifacts land on disk.
- Use a 5-second royalty-free clip in `ml/tests/fixtures/`. No copyrighted audio in the repo.
- Every new pipeline stage adds a unit test + extends the smoke test.

---

## 8. Commands (developer surface)

| Command | Purpose |
|---|---|
| `pnpm install` | JS dependencies |
| `cd ml && uv sync` | Python venv + deps |
| `pnpm tauri dev` | dev shell with HMR |
| `pnpm tauri build` | platform binary |
| `pnpm test` | vitest |
| `pnpm e2e` | Playwright |
| `cd ml && uv run pytest` | Python tests |
| `cd src-tauri && cargo test` | Rust tests |
| `make smoke` | end-to-end on fixture |
| `pnpm lint` / `pnpm fmt` | lint + format all languages |

---

## 9. Boundaries

### Always
- Persist every artifact under `library/<id>/` and check the cache before reprocessing.
- Stream progress to the UI for any task >1 s.
- Keep the Python sidecar as a long-running process; reuse loaded model weights across calls.
- Treat the pipeline as deterministic for a given input (cache by content hash).
- Add a unit test + extend smoke for any new pipeline stage.
- Use OS-appropriate app data dir for `library/` (`tauri::api::path::app_data_dir`).
- Stay strictly within the current phase's scope.

### Ask first
- Adding any cloud / remote dependency.
- Changing the IPC contract format.
- Switching off Tauri / React / Python.
- Bundling a paid or proprietary model.
- Adding telemetry, analytics, or any network call beyond `yt-dlp`.
- Introducing a new top-level dependency in any of the three package managers.

### Never
- Re-distribute or upload downloaded YouTube content.
- Hardcode user data paths.
- Block the UI thread for ML work.
- Edit files outside the project working tree.
- Add features beyond the current phase ("scope creep into phase 2/3").
- Skip git hooks (`--no-verify`) or bypass signing.
- Commit copyrighted audio.

---

## 10. Open questions / known unknowns

- **Time-stretch lib:** Rubberband (best quality, GPL — fine for personal use) vs SoundTouch (LGPL, faster, lower quality). Decide after first prototype.
- **Demucs on Apple Silicon:** try MPS backend, fall back to CPU.
- **basic-pitch latency on long files:** may need chunked inference.
- **Sidecar packaging for distribution:** PyInstaller vs bundled `uv` venv vs PyOxidizer. Defer until end of Phase 1 (irrelevant for personal dev use until then).
- **5-string / drop tunings:** out of scope; revisit after Phase 3.
- **YouTube anti-bot / rate limiting:** if `yt-dlp` breaks, document the workaround rather than hide it.
