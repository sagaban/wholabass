import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Button } from "@/components/ui";

type PingResult = {
  ok: boolean;
  timestamp: number;
  processing_version: number;
};

type IngestResult = {
  song_id: string;
  out_dir: string;
  stems: string[];
  duration_sec: number;
};

type SidecarStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; ping: PingResult }
  | { kind: "error"; message: string };

type IngestStatus =
  | { kind: "idle" }
  | { kind: "running"; path: string }
  | { kind: "ready"; result: IngestResult }
  | { kind: "error"; message: string };

export default function App() {
  const [sidecar, setSidecar] = useState<SidecarStatus>({ kind: "idle" });
  const [ingest, setIngest] = useState<IngestStatus>({ kind: "idle" });
  const [hovering, setHovering] = useState(false);
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
            void runIngest(p.paths[0], setIngest, ingestingRef);
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

  return (
    <main style={{ padding: "2rem", fontSize: "1.1rem" }}>
      <h1 style={{ marginTop: 0 }}>wholabass</h1>
      <SidecarLine status={sidecar} />
      <DropZone hovering={hovering} ingest={ingest} />
    </main>
  );
}

async function runIngest(
  path: string,
  setIngest: (s: IngestStatus) => void,
  ingestingRef: React.MutableRefObject<boolean>,
): Promise<void> {
  ingestingRef.current = true;
  setIngest({ kind: "running", path });
  try {
    const result = await invoke<IngestResult>("ingest_file", { path });
    setIngest({ kind: "ready", result });
  } catch (err: unknown) {
    setIngest({ kind: "error", message: String(err) });
  } finally {
    ingestingRef.current = false;
  }
}

function SidecarLine({ status }: { status: SidecarStatus }) {
  switch (status.kind) {
    case "idle":
    case "loading":
      return <p style={{ opacity: 0.7 }}>sidecar: starting...</p>;
    case "ok": {
      const ts = new Date(status.ping.timestamp * 1000).toISOString();
      return (
        <p>
          sidecar: ok ({ts}) · processing v{status.ping.processing_version}
        </p>
      );
    }
    case "error":
      return <p style={{ color: "#ff7676" }}>sidecar error: {status.message}</p>;
  }
}

function DropZone({
  hovering,
  ingest,
}: {
  hovering: boolean;
  ingest: IngestStatus;
}) {
  const border = hovering ? "2px dashed #6cf" : "2px dashed #444";
  return (
    <section
      style={{
        marginTop: "1.5rem",
        padding: "2rem",
        border,
        borderRadius: 8,
        textAlign: "center",
        opacity: ingest.kind === "running" ? 0.7 : 1,
      }}
    >
      <p style={{ margin: 0 }}>Drop an audio file (mp3 / wav / m4a / flac) here.</p>
      <IngestLine ingest={ingest} />
    </section>
  );
}

function IngestLine({ ingest }: { ingest: IngestStatus }) {
  switch (ingest.kind) {
    case "idle":
      return null;
    case "running":
      return (
        <p style={{ marginTop: "1rem", opacity: 0.8 }}>
          processing: {ingest.path}
        </p>
      );
    case "ready":
      return (
        <div
          style={{
            marginTop: "1rem",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <p style={{ margin: 0 }}>
            ready: <code>{ingest.result.song_id}</code> ·{" "}
            {ingest.result.duration_sec.toFixed(1)}s · stems:{" "}
            {ingest.result.stems.join(", ")}
          </p>
          <Button size="sm" variant="outline" disabled>
            Play (T2)
          </Button>
        </div>
      );
    case "error":
      return (
        <p style={{ marginTop: "1rem", color: "#ff7676" }}>
          error: {ingest.message}
        </p>
      );
  }
}
