import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box, HStack, Stack, VStack, styled } from "styled-system/jsx";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

export interface LibraryEntry {
  song_id: string;
  title: string;
  duration_sec: number;
  processing_version: number;
  created_at: number;
  ready: boolean;
}

type IngestStatus =
  | { kind: "idle" }
  | { kind: "running"; path: string }
  | { kind: "error"; message: string };

interface LibraryScreenProps {
  hovering: boolean;
  ingest: IngestStatus;
  refreshKey: number;
  sidecarLine: React.ReactNode;
  onPick: (entry: { songId: string; title: string }) => void;
}

export function LibraryScreen({
  hovering,
  ingest,
  refreshKey,
  sidecarLine,
  onPick,
}: LibraryScreenProps) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<LibraryEntry[]>("list_library")
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <Box as="main" p="8" fontSize="lg">
      <HStack justifyContent="space-between" alignItems="center" mb="4">
        <styled.h1 m="0">wholabass</styled.h1>
        <ThemeToggle />
      </HStack>
      {sidecarLine}

      <DropZone hovering={hovering} ingest={ingest} />

      <styled.h2 mt="8" mb="3" fontSize="md" fontWeight="semibold" opacity="0.85">
        Library
      </styled.h2>

      {error && (
        <styled.p color="error" m="0">
          list error: {error}
        </styled.p>
      )}

      {!error && entries === null && (
        <styled.p opacity="0.7" m="0">
          loading library...
        </styled.p>
      )}

      {!error && entries !== null && entries.length === 0 && (
        <styled.p opacity="0.7" m="0">
          No songs yet — drop a file above to get started.
        </styled.p>
      )}

      {!error && entries !== null && entries.length > 0 && (
        <Stack gap="1.5">
          {entries.map((entry) => (
            <LibraryRow
              key={entry.song_id}
              entry={entry}
              onClick={() => onPick({ songId: entry.song_id, title: entry.title })}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function LibraryRow({ entry, onClick }: { entry: LibraryEntry; onClick: () => void }) {
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
      <Button
        size="sm"
        variant={entry.ready ? "solid" : "outline"}
        disabled={!entry.ready}
        onClick={onClick}
      >
        Open
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

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
