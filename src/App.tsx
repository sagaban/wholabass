import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Box, Stack, VStack, styled } from "styled-system/jsx";
import { Player } from "@/components/Player";

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
    <Box as="main" p="8" fontSize="lg">
      <styled.h1 mt="0" mb="4">
        wholabass
      </styled.h1>
      <SidecarLine status={sidecar} />
      <DropZone hovering={hovering} ingest={ingest} />
    </Box>
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
      return (
        <styled.p opacity="0.7" m="0">
          sidecar: starting...
        </styled.p>
      );
    case "ok": {
      const ts = new Date(status.ping.timestamp * 1000).toISOString();
      return (
        <styled.p m="0">
          sidecar: ok ({ts}) · processing v{status.ping.processing_version}
        </styled.p>
      );
    }
    case "error":
      return (
        <styled.p color="error" m="0">
          sidecar error: {status.message}
        </styled.p>
      );
  }
}

function DropZone({
  hovering,
  ingest,
}: {
  hovering: boolean;
  ingest: IngestStatus;
}) {
  return (
    <Box
      as="section"
      mt="6"
      p="8"
      borderWidth="2px"
      borderStyle="dashed"
      borderColor={hovering ? "iris.9" : "border"}
      borderRadius="l3"
      textAlign="center"
      opacity={ingest.kind === "running" ? 0.7 : 1}
      transition="border-color 120ms ease"
    >
      <styled.p m="0">Drop an audio file (mp3 / wav / m4a / flac) here.</styled.p>
      <IngestLine ingest={ingest} />
    </Box>
  );
}

function IngestLine({ ingest }: { ingest: IngestStatus }) {
  switch (ingest.kind) {
    case "idle":
      return null;
    case "running":
      return (
        <styled.p mt="4" opacity="0.8">
          processing: {ingest.path}
        </styled.p>
      );
    case "ready":
      return (
        <VStack mt="4" gap="2" alignItems="center">
          <styled.p m="0">
            ready: <styled.code>{ingest.result.song_id}</styled.code> ·{" "}
            {ingest.result.duration_sec.toFixed(1)}s · stems:{" "}
            {ingest.result.stems.join(", ")}
          </styled.p>
          <Player songId={ingest.result.song_id} />
        </VStack>
      );
    case "error":
      return (
        <Stack mt="4">
          <styled.p color="error" m="0">
            error: {ingest.message}
          </styled.p>
        </Stack>
      );
  }
}
