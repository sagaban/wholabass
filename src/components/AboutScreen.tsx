import { useNavigate } from "@tanstack/react-router";
import { Box, HStack, styled, VStack } from "styled-system/jsx";
import { Button } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";

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

      <styled.p mt="8" fontSize="sm" opacity="0.6">
        Missing a credit? Open an issue at the project's repo.
      </styled.p>
    </Box>
  );
}
