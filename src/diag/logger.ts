// Thin shim around @tauri-apps/plugin-log so call sites don't have to
// remember to await the plugin's fire-and-forget API. Anything logged
// here goes to the rolling file in the OS log dir (macOS:
// ~/Library/Logs/com.santiagobandiera.wholabass/wholabass.log), and is
// mirrored to stdout + the WebView console.
//
// We also keep a small in-memory ring buffer of the most recent
// entries so the "copy diagnostics" button (and the error handlers in
// main.tsx) can dump a tail of recent activity without re-reading the
// log file. The ring is per-WebView-session — it gets wiped on
// reload, which is fine because the file has everything.

import { debug, error, info, warn } from "@tauri-apps/plugin-log";

type Level = "debug" | "info" | "warn" | "error";

interface RingEntry {
  ts: number;
  level: Level;
  msg: string;
}

const RING_CAPACITY = 200;
const ring: RingEntry[] = [];

function pushRing(level: Level, msg: string) {
  ring.push({ ts: Date.now(), level, msg });
  if (ring.length > RING_CAPACITY) ring.shift();
}

// `fire(fn, msg)` swallows the plugin's Promise — call sites stay
// synchronous, and a Tauri-side log failure (rare; channel down)
// never crashes the caller. We do NOT await: the file write is
// off-thread on the Rust side anyway, so blocking would just add
// latency for no gain.
function fire(level: Level, msg: string, fn: (m: string) => Promise<void>): void {
  pushRing(level, msg);
  // try/catch covers the synchronous path (e.g. plugin import failed
  // and `fn` is undefined), .catch covers the async one (plugin
  // channel down). Either way the in-memory ring still has the
  // entry, and we mirror to console as a last resort so a logger
  // failure can never block render or hide an upstream error.
  try {
    fn(msg).catch((err) => {
      console.error(`[${level}] logger send failed:`, err, "msg:", msg);
    });
  } catch (err) {
    console.error(`[${level}] logger threw:`, err, "msg:", msg);
  }
}

export const log = {
  debug: (msg: string) => fire("debug", msg, debug),
  info: (msg: string) => fire("info", msg, info),
  warn: (msg: string) => fire("warn", msg, warn),
  error: (msg: string) => fire("error", msg, error),
};

export function recentLogs(): RingEntry[] {
  return [...ring];
}

export function recentLogsAsText(): string {
  return ring
    .map((r) => `[${new Date(r.ts).toISOString()}] ${r.level.toUpperCase()} ${r.msg}`)
    .join("\n");
}
