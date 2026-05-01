import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui";
import { applyMode, readStoredMode, type ColorMode } from "@/theme/mode";

export function ThemeToggle() {
  const [mode, setMode] = useState<ColorMode>(readStoredMode);

  const toggle = () => {
    const next: ColorMode = mode === "light" ? "dark" : "light";
    setMode(next);
    applyMode(next);
  };

  const Icon = mode === "light" ? Moon : Sun;
  const label = mode === "light" ? "Switch to dark" : "Switch to light";

  return (
    <Button size="sm" variant="outline" onClick={toggle} aria-label={label} title={label}>
      <Icon size={16} />
    </Button>
  );
}
