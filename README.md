# wholabass

Bass-practice desktop app. YouTube URL or local audio file → 4-stem separation → multi-channel player with per-stem volume → bass piano-roll synced to playback → slow-down + A-B loop.

See [SPEC.md](SPEC.md) for the full design and [tasks/plan.md](tasks/plan.md) for the build plan. Status below.

---

## Prerequisites

| Tool   | Min version | Used for                            |
| ------ | ----------- | ----------------------------------- |
| Node   | 22.x        | Vite + React frontend               |
| pnpm   | 10.x        | JS package manager                  |
| Rust   | 1.77+       | Tauri shell                         |
| uv     | 0.9+        | Python sidecar (auto-installs 3.11) |

On macOS:

```sh
brew install node pnpm rustup uv
rustup-init -y
```

---

## Install

```sh
pnpm install                 # JS deps
cd ml && uv sync && cd ..    # Python sidecar deps + venv
```

The first `cargo build` downloads Rust crates automatically.

---

## Run (development)

```sh
pnpm tauri dev
```

This starts Vite, builds the Tauri shell, opens a window. The Rust shell spawns the Python sidecar via `uv run python server.py`. On startup you should see **"sidecar: ok (timestamp) · processing v1"** in the window — that confirms the IPC roundtrip works.

Closing the window terminates the Python sidecar (`kill_on_drop`).

> macOS note: the `tauri` npm script unsets `DYLD_LIBRARY_PATH` before exec.
> Some Homebrew formulas export it globally, which makes the dyld loader pull
> Homebrew copies of system libs and crash the WebKit window on open. See
> [wxWidgets#23547](https://github.com/wxWidgets/wxWidgets/issues/23547) and
> [Homebrew/discussions/5420](https://github.com/orgs/Homebrew/discussions/5420).
> If you invoke `tauri` outside pnpm, run `DYLD_LIBRARY_PATH= tauri ...` yourself.

---

## Build (production)

```sh
pnpm tauri build
```

Produces a platform binary under `src-tauri/target/release/bundle/`. macOS is the primary target; Windows + Linux should work but are unverified.

> Note: bundle icons in `src-tauri/icons/` are placeholders. Replace before any release. `icon.icns` / `icon.ico` are removed from the bundle config for now.

---

## Test

| Command                                | What it runs                              |
| -------------------------------------- | ----------------------------------------- |
| `cd src-tauri && cargo test`           | Rust unit + integration tests             |
| `cd src-tauri && cargo clippy --all-targets -- -D warnings` | Rust lint  |
| `cd ml && uv run pytest`               | Python sidecar tests                      |
| `cd ml && uv run ruff check .`         | Python lint                               |
| `cd ml && uv run mypy`                 | Python type check (strict)                |
| `pnpm exec tsc --noEmit`               | TypeScript type check                     |
| `pnpm build`                           | Frontend production build                 |

The cargo integration test in `src-tauri/tests/sidecar_ping.rs` actually spawns the Python sidecar via `uv` and pings it end-to-end — so a failing one usually means the Python environment is broken.

---

## Project layout

```
wholabass/
├── SPEC.md             design + boundaries
├── tasks/              plan.md, todo.md
├── src/                React frontend (App.tsx, audio engine later)
├── src-tauri/          Rust shell (Tauri 2)
│   ├── src/ids.rs      song-id helpers (sha256, YouTube URL parsing)
│   ├── src/ipc.rs      JSON-RPC stdio client to the Python sidecar
│   └── src/lib.rs      Tauri setup + commands (`ping` for now)
├── ml/                 Python sidecar (managed by uv)
│   ├── server.py       newline-JSON-RPC stdio loop
│   └── tests/
└── library/            user data (gitignored): downloads, stems, MIDI
```

The sidecar protocol is one JSON object per line over stdio:

```
→ {"id": "1", "method": "ping",  "params": {}}
← {"id": "1", "result": {"timestamp": 1714521600.0, "version": "0.1.0"}}
```

---

## Status

Phase 1 progress (see [tasks/todo.md](tasks/todo.md)):

- [x] T0 — Foundation scaffold (Tauri + React + TS + Python sidecar)
- [ ] T1 — Local file → 4 stems on disk (Demucs)
- [ ] T2 — Multi-stem synced playback
- [ ] T3 — Stem mixer
- [ ] T4 — Cache short-circuit
- [ ] T5 — YouTube URL ingest
- [ ] T6 — Bass MIDI + piano-roll
- [ ] T7 — Time-stretch (slow-down)
- [ ] T8 — A-B loop

Today, the app boots, the Python sidecar starts, and `ping` round-trips. Nothing else does anything yet.
