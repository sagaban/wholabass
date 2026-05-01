import { Box, HStack, styled } from "styled-system/jsx";
import { Button } from "@/components/ui";
import { Player } from "@/components/Player";
import { ThemeToggle } from "@/components/ThemeToggle";

interface PlayerScreenProps {
  songId: string;
  title: string;
  onBack: () => void;
}

export function PlayerScreen({ songId, title, onBack }: PlayerScreenProps) {
  return (
    <Box as="main" p="8" fontSize="lg">
      <HStack justifyContent="space-between" alignItems="center" mb="4">
        <HStack gap="3" alignItems="center">
          <Button size="sm" variant="outline" onClick={onBack}>
            ← Back
          </Button>
          <styled.h1 m="0" fontSize="2xl">
            {title}
          </styled.h1>
        </HStack>
        <ThemeToggle />
      </HStack>
      <styled.div fontSize="xs" opacity="0.6" mb="4">
        <styled.code>{songId}</styled.code>
      </styled.div>
      <Player songId={songId} />
    </Box>
  );
}
