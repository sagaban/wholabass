import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNavigate } from "@tanstack/react-router";
import { Box, HStack, Stack, VStack, styled } from "styled-system/jsx";
import logoUrl from "@/assets/logo.png";
import { Button, Dialog } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

interface PingResult {
  ok: boolean;
  timestamp: number;
  processing_version: number;
}

interface IngestResult {
  song_id: string;
  out_dir: string;
  stems: string[];
  duration_sec: number;
  cache_hit: boolean;
}

export interface LibraryEntry {
  song_id: string;
  title: string;
  duration_sec: number;
  processing_version: number;
  created_at: number;
  ready: boolean;
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

interface ProgressEvent {
  progress: number;
  stage: string;
}

interface IngestProgress {
  progress: number;
  stage: string;
  startedAt: number;
}

export function LibraryScreen() {
  const navigate = useNavigate();
  const [sidecar, setSidecar] = useState<SidecarStatus>({ kind: "idle" });
  const [ingest, setIngest] = useState<IngestStatus>({ kind: "idle" });
  const [hovering, setHovering] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const ingestingRef = useRef(false);

  // Sidecar ping (once on mount).
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

  // Library list — refetch when refreshKey bumps.
  useEffect(() => {
    let cancelled = false;
    invoke<LibraryEntry[]>("list_library")
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
          setListError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Subscribe to sidecar progress events while ingesting.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void listen<ProgressEvent>("ingest:progress", (event) => {
      setProgress((prev) => ({
        progress: event.payload.progress,
        stage: event.payload.stage,
        startedAt: prev?.startedAt ?? Date.now(),
      }));
    }).then((fn) => {
      if (!mounted) fn();
      else unlisten = fn;
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  // Reset progress when an ingest starts (so the elapsed clock is fresh)
  // or finishes.
  useEffect(() => {
    if (ingest.kind === "running") {
      setProgress({ progress: 0, stage: "starting", startedAt: Date.now() });
    } else {
      setProgress(null);
    }
  }, [ingest.kind]);

  // Drag-drop — only mounted while this screen is alive.
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
            void runIngest(
              { kind: "file", path: p.paths[0] },
              setIngest,
              ingestingRef,
              (result) => {
                setRefreshKey((k) => k + 1);
                void navigate({
                  to: "/play/$songId",
                  params: { songId: result.song_id },
                  search: { title: titleFromPath(p.paths[0]) },
                });
              },
            );
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
  }, [navigate]);

  return (
    <Box as="main" p="8" fontSize="lg" maxWidth="3xl" mx="auto" w="full">
      <HStack justifyContent="space-between" alignItems="center" mb="4">
        <styled.img src={logoUrl} alt="wholabass" h="12" w="auto" />
        <ThemeToggle />
      </HStack>
      <SidecarLine status={sidecar} />

      <DropZone hovering={hovering} ingest={ingest} />

      <UrlInput
        ingest={ingest}
        onSubmit={(url) =>
          void runIngest({ kind: "url", url }, setIngest, ingestingRef, (result) => {
            setRefreshKey((k) => k + 1);
            void navigate({
              to: "/play/$songId",
              params: { songId: result.song_id },
              search: { title: result.song_id },
            });
          })
        }
      />

      {ingest.kind === "running" && progress && <IngestProgressBar progress={progress} />}

      <styled.h2 mt="8" mb="3" fontSize="md" fontWeight="semibold" opacity="0.85">
        Library
      </styled.h2>

      {listError && (
        <styled.p color="error" m="0">
          list error: {listError}
        </styled.p>
      )}

      {!listError && entries === null && (
        <styled.p opacity="0.7" m="0">
          loading library...
        </styled.p>
      )}

      {!listError && entries !== null && entries.length === 0 && (
        <styled.p opacity="0.7" m="0">
          No songs yet — drop a file above to get started.
        </styled.p>
      )}

      {!listError && entries !== null && entries.length > 0 && (
        <Stack gap="1.5">
          {entries.map((entry) => (
            <LibraryRow
              key={entry.song_id}
              entry={entry}
              onOpen={() =>
                void navigate({
                  to: "/play/$songId",
                  params: { songId: entry.song_id },
                  search: { title: entry.title },
                })
              }
              onDelete={() => {
                setDeleteError(null);
                setPendingDelete(entry);
              }}
            />
          ))}
        </Stack>
      )}

      <ConfirmDeleteDialog
        entry={pendingDelete}
        error={deleteError}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await invoke<void>("delete_song", { songId: pendingDelete.song_id });
            setPendingDelete(null);
            setDeleteError(null);
            setRefreshKey((k) => k + 1);
          } catch (err: unknown) {
            setDeleteError(String(err));
          }
        }}
      />
    </Box>
  );
}

type IngestSource = { kind: "file"; path: string } | { kind: "url"; url: string };

async function runIngest(
  source: IngestSource,
  setIngest: (s: IngestStatus) => void,
  ingestingRef: React.MutableRefObject<boolean>,
  onReady: (result: IngestResult) => void,
): Promise<void> {
  ingestingRef.current = true;
  const label = source.kind === "file" ? source.path : source.url;
  setIngest({ kind: "running", path: label });
  try {
    const result =
      source.kind === "file"
        ? await invoke<IngestResult>("ingest_file", { path: source.path })
        : await invoke<IngestResult>("ingest_url", { url: source.url });
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

function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function LibraryRow({
  entry,
  onOpen,
  onDelete,
}: {
  entry: LibraryEntry;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <HStack
      gap="3"
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      alignItems="center"
      justifyContent="space-between"
      opacity={entry.ready ? 1 : 0.55}
    >
      <VStack alignItems="flex-start" gap="0.5">
        <styled.div fontWeight="medium">{entry.title}</styled.div>
        <styled.div fontSize="xs" opacity="0.7">
          <styled.code>{entry.song_id}</styled.code> · {fmtTime(entry.duration_sec)} · v
          {entry.processing_version}
          {!entry.ready && " · stale"}
        </styled.div>
      </VStack>
      <HStack gap="2">
        <Button
          size="sm"
          variant={entry.ready ? "solid" : "outline"}
          disabled={!entry.ready}
          onClick={onOpen}
        >
          Open
        </Button>
        <Button size="sm" variant="outline" onClick={onDelete} aria-label={`delete ${entry.title}`}>
          Delete
        </Button>
      </HStack>
    </HStack>
  );
}

function ConfirmDeleteDialog({
  entry,
  error,
  onCancel,
  onConfirm,
}: {
  entry: LibraryEntry | null;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root
      open={entry !== null}
      onOpenChange={(d) => {
        if (!d.open) onCancel();
      }}
    >
      <Dialog.Backdrop />
      <Dialog.Positioner>
        <Dialog.Content>
          <Stack gap="4" p="6">
            <Stack gap="1">
              <Dialog.Title>Delete this song?</Dialog.Title>
              <Dialog.Description>
                {entry ? (
                  <>
                    Removes <styled.code>{entry.song_id}</styled.code> ({entry.title}) and its stems
                    from disk. This cannot be undone.
                  </>
                ) : null}
              </Dialog.Description>
            </Stack>
            {error && (
              <styled.p color="error" m="0" fontSize="sm">
                {error}
              </styled.p>
            )}
            <HStack gap="2" justifyContent="flex-end">
              <Button size="sm" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="sm" colorPalette="red" onClick={onConfirm}>
                Delete
              </Button>
            </HStack>
          </Stack>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting…",
  downloading: "Downloading from YouTube",
  download_error: "Download failed — retrying",
  loading_model: "Loading separation model",
  loading_source: "Loading audio",
  separating: "Separating stems (this takes a moment)",
  writing_stems: "Writing stem files",
  done: "Finishing up",
};

function IngestProgressBar({ progress }: { progress: IngestProgress }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, (now - progress.startedAt) / 1000);
  const label = STAGE_LABELS[progress.stage] ?? progress.stage;
  const pct = Math.max(0, Math.min(100, progress.progress));

  return (
    <Box mt="4" p="3" borderWidth="1px" borderColor="border" borderRadius="l2">
      <HStack justifyContent="space-between" alignItems="center" mb="2">
        <HStack gap="2" alignItems="center">
          <styled.span
            display="inline-block"
            w="2"
            h="2"
            borderRadius="full"
            bg="indigo.9"
            animation="pulse 1.4s ease-in-out infinite"
          />
          <styled.span fontSize="sm">{label}…</styled.span>
        </HStack>
        <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
          {pct.toFixed(0)}% · {elapsed.toFixed(1)}s
        </styled.span>
      </HStack>
      <Box w="full" h="1.5" bg="border" borderRadius="full" overflow="hidden">
        <Box h="full" bg="indigo.9" width={`${pct}%`} transition="width 200ms ease" />
      </Box>
    </Box>
  );
}

function UrlInput({ ingest, onSubmit }: { ingest: IngestStatus; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const disabled = ingest.kind === "running" || trimmed === "";
  const submit = () => {
    if (!disabled) onSubmit(trimmed);
  };
  return (
    <HStack mt="3" gap="2">
      <styled.input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="…or paste a YouTube URL"
        flex="1"
        px="3"
        py="2"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        bg="canvas"
        color="fg.default"
        fontSize="md"
        _placeholder={{ color: "fg.subtle" }}
        _focus={{ outline: "none", borderColor: "indigo.9" }}
      />
      <Button onClick={submit} disabled={disabled}>
        Submit
      </Button>
    </HStack>
  );
}

function DropZone({ hovering, ingest }: { hovering: boolean; ingest: IngestStatus }) {
  return (
    <Box
      as="section"
      mt="6"
      p="8"
      borderWidth="2px"
      borderStyle="dashed"
      borderColor={hovering ? "indigo.9" : "border"}
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
    case "error":
      return (
        <styled.p mt="4" color="error">
          error: {ingest.message}
        </styled.p>
      );
  }
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

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
