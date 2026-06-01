import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Box, HStack, styled, VStack } from "styled-system/jsx";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import { recentLogsAsText } from "@/diag/logger";

interface Credit {
  name: string;
  url: string;
  note?: string;
}

interface Section {
  title: string;
  credits: Credit[];
}

const SECTIONS: Section[] = [
  {
    title: "Shell & framework",
    credits: [
      { name: "Tauri 2", url: "https://tauri.app", note: "Rust desktop shell" },
      { name: "React 19", url: "https://react.dev" },
      { name: "TypeScript", url: "https://www.typescriptlang.org" },
      { name: "Vite", url: "https://vitejs.dev" },
      { name: "TanStack Router", url: "https://tanstack.com/router" },
    ],
  },
  {
    title: "UI & styling",
    credits: [
      { name: "Panda CSS", url: "https://panda-css.com", note: "atomic-CSS engine" },
      { name: "Park UI", url: "https://park-ui.com", note: "component primitives" },
      { name: "Ark UI", url: "https://ark-ui.com", note: "headless behaviors under Park UI" },
      { name: "Lucide", url: "https://lucide.dev", note: "icon set" },
      { name: "Victor Mono", url: "https://rubjo.github.io/victor-mono/", note: "font" },
    ],
  },
  {
    title: "Audio & MIDI",
    credits: [
      {
        name: "Web Audio API",
        url: "https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API",
      },
      { name: "@tonejs/midi", url: "https://github.com/Tonejs/Midi", note: "MIDI parsing" },
      {
        name: "@soundtouchjs/audio-worklet",
        url: "https://github.com/cutterbl/SoundTouchJS",
        note: "real-time time-stretching",
      },
      {
        name: "alphaTab",
        url: "https://www.alphatab.net",
        note: "Guitar Pro / alphaTab score model + MIDI export",
      },
    ],
  },
  {
    title: "Songsterr import",
    credits: [
      {
        name: "songsterr-downloader",
        url: "https://github.com/Metaphysics0/songsterr-downloader",
        note: "Songsterr → alphaTab converter (MIT, vendored)",
      },
    ],
  },
  {
    title: "Python sidecar",
    credits: [
      {
        name: "Demucs",
        url: "https://github.com/facebookresearch/demucs",
        note: "stem separation (vocals / drums / bass / other)",
      },
      {
        name: "basic-pitch",
        url: "https://github.com/spotify/basic-pitch",
        note: "polyphonic transcription",
      },
      {
        name: "torchcrepe",
        url: "https://github.com/maxrmorrison/torchcrepe",
        note: "monophonic pitch tracker for bass",
      },
      { name: "librosa", url: "https://librosa.org", note: "beat tracking" },
      { name: "yt-dlp", url: "https://github.com/yt-dlp/yt-dlp", note: "audio fetch from URLs" },
      { name: "uv", url: "https://github.com/astral-sh/uv", note: "Python env manager" },
    ],
  },
  {
    title: "Dev tooling",
    credits: [
      {
        name: "oxlint / oxfmt",
        url: "https://oxc.rs",
        note: "Rust-based JS lint + formatter",
      },
      { name: "vitest", url: "https://vitest.dev", note: "frontend tests" },
      { name: "pnpm", url: "https://pnpm.io", note: "package manager" },
    ],
  },
];

export function AboutScreen() {
  const navigate = useNavigate();
  return (
    <Box as="main" p="8" fontSize="lg" maxWidth="3xl" mx="auto" w="full">
      <HStack justifyContent="space-between" alignItems="center" mb="6">
        <HStack gap="3" alignItems="center">
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/" })}>
            ← Back
          </Button>
          <styled.h1 m="0" fontSize="2xl">
            About
          </styled.h1>
        </HStack>
        <ThemeToggle />
      </HStack>

      <styled.p mt="0" mb="6" opacity="0.85">
        wholabass is a bass-practice desktop app. Below are the open-source projects it stands on,
        listed in rough order of which layer of the stack they live at.
      </styled.p>

      <VStack gap="6" alignItems="stretch">
        {SECTIONS.map((section) => (
          <Box key={section.title}>
            <styled.h2 m="0" mb="2" fontSize="lg" fontWeight="semibold">
              {section.title}
            </styled.h2>
            <VStack gap="1" alignItems="stretch">
              {section.credits.map((credit) => (
                <HStack key={credit.name} gap="2" alignItems="baseline" flexWrap="wrap">
                  <styled.a
                    href={credit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="indigo.11"
                    fontWeight="medium"
                    _hover={{ textDecoration: "underline" }}
                  >
                    {credit.name}
                  </styled.a>
                  {credit.note && (
                    <styled.span fontSize="sm" opacity="0.7">
                      — {credit.note}
                    </styled.span>
                  )}
                </HStack>
              ))}
            </VStack>
          </Box>
        ))}
      </VStack>

      <DiagnosticsBlock />

      <styled.p mt="8" fontSize="sm" opacity="0.6">
        Missing a credit? Open an issue at the project's repo.
      </styled.p>
    </Box>
  );
}

function DiagnosticsBlock() {
  const [status, setStatus] = useState<string | null>(null);

  const onCopy = async () => {
    const text = [
      `wholabass diagnostics @ ${new Date().toISOString()}`,
      `userAgent: ${navigator.userAgent}`,
      `platform: ${navigator.platform}`,
      "",
      "── recent log (in-memory tail) ──",
      recentLogsAsText() || "(empty)",
      "",
      "── persistent log file ──",
      "macOS: ~/Library/Logs/com.santiagobandiera.wholabass/wholabass.log",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied to clipboard");
    } catch {
      setStatus("clipboard unavailable");
    }
  };

  return (
    <Box mt="8" pt="6" borderTopWidth="1px" borderColor="border.default">
      <styled.h2 m="0" mb="2" fontSize="lg" fontWeight="semibold">
        Diagnostics
      </styled.h2>
      <styled.p mt="0" mb="3" fontSize="sm" opacity="0.7">
        If the app crashed or behaved unexpectedly, the persistent log is at{" "}
        <styled.code fontSize="xs">
          ~/Library/Logs/com.santiagobandiera.wholabass/wholabass.log
        </styled.code>
        . The button below copies the last few hundred in-memory entries plus that path to the
        clipboard.
      </styled.p>
      <HStack gap="3" alignItems="center">
        <Button size="sm" variant="outline" onClick={() => void onCopy()}>
          Copy diagnostics
        </Button>
        {status && (
          <styled.span fontSize="sm" opacity="0.7">
            {status}
          </styled.span>
        )}
      </HStack>
    </Box>
  );
}
