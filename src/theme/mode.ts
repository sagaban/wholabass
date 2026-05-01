/**
 * Light/dark mode controller.
 *
 * Park UI's `conditions` exposes `light` as `:root &, .light &`, which makes
 * light the default. Panda's stock `_dark` condition is `&.dark, .dark &`,
 * so flipping the `.dark` class on `<html>` switches the theme.
 */

export type ColorMode = "light" | "dark";

const STORAGE_KEY = "wholabass-color-mode";
const DARK_CLASS = "dark";

export function readStoredMode(): ColorMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // localStorage may be unavailable (private mode, etc.)
  }
  return "light";
}

export function applyMode(mode: ColorMode): void {
  const root = document.documentElement;
  if (mode === "dark") root.classList.add(DARK_CLASS);
  else root.classList.remove(DARK_CLASS);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}
