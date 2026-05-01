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
  title: string;
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
  has_source: boolean;
  has_stems: boolean;
  has_midi: boolean;
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
                  search: { title: result.title },
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
              search: { title: result.title },
            });
          })
        }
      />

      {ingest.kind === "running" && progress && (
        <IngestProgressBar
          progress={progress}
          onCancel={async () => {
            try {
              await invoke<string | null>("cancel_ingest");
            } catch (err: unknown) {
              console.error("cancel failed:", err);
            }
            setRefreshKey((k) => k + 1);
          }}
        />
      )}

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
              busy={ingest.kind === "running"}
              onOpen={() =>
                void navigate({
                  to: "/play/$songId",
                  params: { songId: entry.song_id },
                  search: { title: entry.title },
                })
              }
              onRetry={() => {
                if (ingestingRef.current) return;
                void runRetry(entry.song_id, setIngest, ingestingRef, (result) => {
                  setRefreshKey((k) => k + 1);
                  void navigate({
                    to: "/play/$songId",
                    params: { songId: result.song_id },
                    search: { title: result.title },
                  });
                });
              }}
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

async function runRetry(
  songId: string,
  setIngest: (s: IngestStatus) => void,
  ingestingRef: React.MutableRefObject<boolean>,
  onReady: (result: IngestResult) => void,
): Promise<void> {
  ingestingRef.current = true;
  setIngest({ kind: "running", path: songId });
  try {
    const result = await invoke<IngestResult>("retry_song", { songId });
    console.log(
      `retry ${result.cache_hit ? "no-op" : "completed"}: ${result.song_id} (${result.duration_sec.toFixed(1)}s)`,
    );
    setIngest({ kind: "idle" });
    onReady(result);
  } catch (err: unknown) {
    setIngest({ kind: "error", message: String(err) });
  } finally {
    ingestingRef.current = false;
  }
}

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

function LibraryRow({
  entry,
  busy,
  onOpen,
  onRetry,
  onDelete,
}: {
  entry: LibraryEntry;
  busy: boolean;
  onOpen: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const canRetry = !entry.ready && entry.has_source;
  return (
    <HStack
      gap="3"
      p="3"
      borderWidth="1px"
      borderColor="border"
      borderRadius="l2"
      alignItems="center"
      justifyContent="space-between"
      opacity={entry.ready ? 1 : 0.85}
    >
      <VStack alignItems="flex-start" gap="1">
        <styled.div fontWeight="medium">{entry.title}</styled.div>
        <styled.div fontSize="xs" opacity="0.7">
          <styled.code>{entry.song_id}</styled.code> · {fmtTime(entry.duration_sec)} · v
          {entry.processing_version}
        </styled.div>
        {!entry.ready && (
          <HStack gap="1" mt="0.5">
            <StepPill label="source" done={entry.has_source} />
            <StepPill label="stems" done={entry.has_stems} />
            <StepPill label="midi" done={entry.has_midi} />
          </HStack>
        )}
      </VStack>
      <HStack gap="2">
        {entry.ready ? (
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onRetry}
            disabled={!canRetry || busy}
            aria-label={`retry ${entry.title}`}
          >
            {canRetry ? "Retry" : "Re-ingest"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onDelete} aria-label={`delete ${entry.title}`}>
          Delete
        </Button>
      </HStack>
    </HStack>
  );
}

function StepPill({ label, done }: { label: string; done: boolean }) {
  return (
    <styled.span
      fontSize="2xs"
      px="1.5"
      py="0.5"
      borderRadius="full"
      borderWidth="1px"
      borderColor={done ? "indigo.7" : "border"}
      bg={done ? "indigo.4" : "transparent"}
      color={done ? "indigo.12" : "fg.muted"}
      fontVariantNumeric="tabular-nums"
    >
      {done ? "✓" : "·"} {label}
    </styled.span>
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
  separating: "Separating stems",
  writing_stems: "Writing stem files",
  done: "Finishing up",
};

/** Each stage maps into a fixed slice of the overall 0-100 bar. */
const STAGE_RANGES: Record<string, [number, number]> = {
  starting: [0, 3],
  downloading: [3, 50],
  download_error: [3, 3],
  loading_model: [50, 55],
  loading_source: [55, 58],
  separating: [58, 90],
  writing_stems: [90, 98],
  done: [98, 100],
};

function overallPercent(stage: string, stagePct: number): number {
  const [lo, hi] = STAGE_RANGES[stage] ?? [0, 100];
  const local = Math.max(0, Math.min(100, stagePct));
  return lo + ((hi - lo) * local) / 100;
}

function IngestProgressBar({
  progress,
  onCancel,
}: {
  progress: IngestProgress;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [maxPct, setMaxPct] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Reset the running-max when a new ingest starts.
  useEffect(() => {
    setMaxPct(0);
  }, [progress.startedAt]);

  // Clamp upward — yt-dlp resets the per-file ratio between fragments,
  // so the raw "downloading" percent can dip; the bar must never pull back.
  useEffect(() => {
    const target = overallPercent(progress.stage, progress.progress);
    setMaxPct((m) => (target > m ? target : m));
  }, [progress.stage, progress.progress]);

  const elapsed = Math.max(0, (now - progress.startedAt) / 1000);
  const label = STAGE_LABELS[progress.stage] ?? progress.stage;
  const pct = maxPct;

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
        <HStack gap="3" alignItems="center">
          <styled.span fontSize="xs" opacity="0.7" fontVariantNumeric="tabular-nums">
            {pct.toFixed(0)}% · {elapsed.toFixed(1)}s
          </styled.span>
          <Button size="xs" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </HStack>
      </HStack>
      <Box w="full" h="1.5" bg="border" borderRadius="full" overflow="hidden">
        <Box
          h="full"
          bg="indigo.9"
          transition="width 200ms ease"
          // Dynamic width — Panda extracts atomic classes at build time, so
          // a runtime `${pct}%` can't be expressed as a style prop. Inline
          // style is the documented carve-out for runtime-computed values.
          style={{ width: `${pct}%` }}
        />
      </Box>
    </Box>
  );
}

function UrlInput({ ingest, onSubmit }: { ingest: IngestStatus; onSubmit: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const running = ingest.kind === "running";
  const disabled = running || trimmed === "";
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
        readOnly={running}
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
        opacity={running ? 0.6 : 1}
        cursor={running ? "not-allowed" : "text"}
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
