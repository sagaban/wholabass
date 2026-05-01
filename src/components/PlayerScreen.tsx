import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Box, HStack, styled } from "styled-system/jsx";
import { Button } from "@/components/ui";
import { Player } from "@/components/Player";
import { ThemeToggle } from "@/components/ThemeToggle";

export function PlayerScreen() {
  const { songId } = useParams({ from: "/play/$songId" });
  const { title } = useSearch({ from: "/play/$songId" });
  const navigate = useNavigate();
  const displayTitle = title ?? songId;

  return (
    <Box as="main" p="8" fontSize="lg" maxWidth="3xl" mx="auto" w="full">
      <HStack justifyContent="space-between" alignItems="center" mb="4">
        <HStack gap="3" alignItems="center">
          <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/" })}>
            ← Back
          </Button>
          <styled.h1 m="0" fontSize="2xl">
            {displayTitle}
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
