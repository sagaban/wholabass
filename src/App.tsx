import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { styled } from "styled-system/jsx";
import { LibraryScreen } from "@/components/LibraryScreen";
import { PlayerScreen } from "@/components/PlayerScreen";

type PingResult = {
  ok: boolean;
  timestamp: number;
  processing_version: number;
};

interface IngestResult {
  song_id: string;
  out_dir: string;
  stems: string[];
  duration_sec: number;
  cache_hit: boolean;
}

type SidecarStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; ping: PingResult }
  | { kind: "error"; message: string };

type IngestStatus =
  | { kind: "idle" }
  | { kind: "running"; path: string }
  | { kind: "error"; message: string };

type Route =
  | { kind: "library" }
  | { kind: "player"; songId: string; title: string };

export default function App() {
  const [sidecar, setSidecar] = useState<SidecarStatus>({ kind: "idle" });
  const [ingest, setIngest] = useState<IngestStatus>({ kind: "idle" });
  const [hovering, setHovering] = useState(false);
  const [route, setRoute] = useState<Route>({ kind: "library" });
  const [refreshKey, setRefreshKey] = useState(0);
  const ingestingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setSidecar({ kind: "loading" });
    invoke<PingResult>("ping")
      .then((ping) => {
        if (!cancelled) setSidecar({ kind: "ok", ping });
      })
      .catch((err: unknown) => {
        if (!cancelled) setSidecar({ kind: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setHovering(true);
        } else if (p.type === "leave") {
          setHovering(false);
        } else if (p.type === "drop") {
          setHovering(false);
          if (!ingestingRef.current && p.paths.length > 0) {
            void runIngest(p.paths[0], setIngest, ingestingRef, (result) => {
              setRefreshKey((k) => k + 1);
              setRoute({
                kind: "player",
                songId: result.song_id,
                title: titleFromIngest(result, p.paths[0]),
              });
            });
          }
        }
      })
      .then((fn) => {
        if (!mounted) fn();
        else unlisten = fn;
      })
      .catch((err: unknown) => {
        console.error("drag-drop listener failed:", err);
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  if (route.kind === "player") {
    return (
      <PlayerScreen
        songId={route.songId}
        title={route.title}
        onBack={() => {
          setIngest({ kind: "idle" });
          setRoute({ kind: "library" });
        }}
      />
    );
  }

  return (
    <LibraryScreen
      hovering={hovering}
      ingest={ingest}
      refreshKey={refreshKey}
      sidecarLine={<SidecarLine status={sidecar} />}
      onPick={({ songId, title }) =>
        setRoute({ kind: "player", songId, title })
      }
    />
  );
}

async function runIngest(
  path: string,
  setIngest: (s: IngestStatus) => void,
  ingestingRef: React.MutableRefObject<boolean>,
  onReady: (result: IngestResult) => void,
): Promise<void> {
  ingestingRef.current = true;
  setIngest({ kind: "running", path });
  try {
    const result = await invoke<IngestResult>("ingest_file", { path });
    console.log(
      `ingest ${result.cache_hit ? "cache hit" : "cache miss"}: ${result.song_id} (${result.duration_sec.toFixed(1)}s)`,
    );
    setIngest({ kind: "idle" });
    onReady(result);
  } catch (err: unknown) {
    setIngest({ kind: "error", message: String(err) });
  } finally {
    ingestingRef.current = false;
  }
}

function titleFromIngest(_result: IngestResult, path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function SidecarLine({ status }: { status: SidecarStatus }) {
  switch (status.kind) {
    case "idle":
    case "loading":
      return (
        <styled.p opacity="0.7" m="0" fontSize="sm">
          sidecar: starting...
        </styled.p>
      );
    case "ok": {
      const ts = new Date(status.ping.timestamp * 1000).toISOString();
      return (
        <styled.p m="0" fontSize="sm" opacity="0.7">
          sidecar: ok ({ts}) · processing v{status.ping.processing_version}
        </styled.p>
      );
    }
    case "error":
      return (
        <styled.p color="error" m="0" fontSize="sm">
          sidecar error: {status.message}
        </styled.p>
      );
  }
}
