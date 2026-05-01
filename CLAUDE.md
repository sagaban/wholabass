# wholabass — instructions for Claude

Bass-practice desktop app. Tauri 2 (Rust) + React 19 + TS (Vite) + Python 3.11 sidecar (uv-managed).

## Read these first

- `SPEC.md` — authoritative scope, boundaries, acceptance criteria, file layout, testing strategy. Don't duplicate it; cite it.
- `tasks/plan.md` — Phase 1 build plan with per-task acceptance criteria.
- `tasks/todo.md` — current progress.
- `README.md` — setup / run / test / project layout.

If something here conflicts with SPEC.md, SPEC.md wins.

## Stack quick map

- `src/` — React frontend.
- `src-tauri/src/` — Rust shell. `lib.rs` = entry + commands; `ipc.rs` = JSON-RPC stdio client; `ids.rs` = song-id (sha256, 12 hex chars; YouTube URL parsing).
- `ml/server.py` — Python sidecar (newline-delimited JSON-RPC over stdio).
- `library/` — user data, gitignored. Layout per SPEC §5; cache rules per SPEC §5.
- `src-tauri/tests/sidecar_ping.rs` — model integration test: spawns a real sidecar via `uv run` and pings it.

## Commands

| | |
|---|---|
| `pnpm tauri dev` | run app (Vite + Tauri shell + sidecar) |
| `pnpm exec tsc --noEmit` | TS typecheck |
| `pnpm build` | frontend prod build |
| `pnpm test` | vitest |
| `cd src-tauri && cargo test` | Rust tests |
| `cd src-tauri && cargo clippy --all-targets -- -D warnings` | Rust lint (warnings fail) |
| `cd ml && uv run pytest` | Python tests |
| `cd ml && uv run ruff check .` | Python lint |
| `cd ml && uv run mypy` | Python type-check (strict) |

Run lint + typecheck for every stack you touched before reporting "done".

## Sidecar protocol (per SPEC §4)

Newline-delimited JSON, one object per line:

```
→ {"id": "...", "method": "...", "params": {...}}
← {"id": "...", "progress": 0..100, "stage": "..."}     # may stream multiple
← {"id": "...", "result": {...}}                        # success
← {"id": "...", "error": {"code": "...", "message": "..."}}
```

Adding a method = handler in `ml/server.py` + typed wrapper in `src-tauri/src/ipc.rs` + Tauri command in `src-tauri/src/lib.rs` + test on both sides.

## Non-obvious rules (everything else, defer to SPEC.md)

- macOS: the `tauri` npm script unsets `DYLD_LIBRARY_PATH` (Homebrew leak crashes WebKit on window open). Don't remove the prefix.
- Long-running work goes in the Python sidecar, never blocking Rust or the UI thread.
- Frontend never spawns Python — always via Tauri commands → Rust → IPC → sidecar.
- Sidecar is one long-running process; reuse loaded model weights across calls.
- Cache by content hash (`ids.rs`); skip pipeline on cache hit; reprocess if `PROCESSING_VERSION` mismatches.
- Don't mock the sidecar in Rust integration tests — spawn it for real (model: `tests/sidecar_ping.rs`).
- Don't bake user paths; use `tauri::api::path::app_data_dir` for `library/`.
- Stay strictly within the current phase's scope (SPEC §9).

## Working agreements

- Each Phase 1 task (T1–T12) is a thin vertical slice. Build → test → commit → move on. Don't pre-build T_n+1 scaffolding while doing T_n.
- Commit message style: `T<N>: <imperative>` for task work, otherwise `<prefix>: <imperative>` (`fix:`, `docs:`, `deps:`, `tasks:`). One commit per logical change.
- Don't add deps without asking (SPEC §9 "Ask first").
- Don't `--no-verify`, don't force-push, don't amend pushed commits.

## Skills to apply (agent-skills)

Invoke these by name when the task fits — do not re-derive their contents:

- `incremental-implementation` — every T1–T12. Slice → test → ship.
- `test-driven-development` — failing test first; integration over mocks (sidecar fixture is the model).
- `api-and-interface-design` — when adding sidecar methods, Tauri commands, or changing IPC envelope.
- `frontend-ui-engineering` — audio player UI (T2), stem mixer (T3), piano-roll canvas (T6), practice panel (T7/T8).
- `performance-optimization` — multi-stem sync ±20 ms (T2), live volume changes without glitches (T3), time-stretch quality + latency (T7), piano-roll scroll smoothness (T6). Measure before optimizing.
- `debugging-and-error-recovery` — sidecar IPC failures, audio engine glitches, Demucs/basic-pitch errors.
- `code-review-and-quality` — before each task PR.
- `git-workflow-and-versioning` — atomic commits, no `--no-verify`.
- `ci-cd-and-automation` — T12 (smoke + lint/format CI).
- `documentation-and-adrs` — only when boundaries shift; update SPEC.md, not scattered docs.
- `security-and-hardening` — narrow surface here, but: validate user-supplied paths, sanitize YouTube URLs (already done in `ids.rs`), don't shell-exec untrusted input.

Less relevant for this project: `idea-refine` (past), `browser-testing-with-devtools` (Tauri WebView, limited), `shipping-and-launch` (no distribution per SPEC §1 non-goals).
