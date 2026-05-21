// Lazy-injects an `@font-face` rule pointing at the Bravura woff2 we
// vendor under `src/assets/fonts/`. Bravura is the reference SMuFL music
// font (OFL licensed, Steinberg) — all the standard music glyphs live at
// their canonical SMuFL Private-Use-Area codepoints (rests at
// E4E0..E4EA, note heads at E0A0.., etc).
//
// We import the file directly rather than pulling it from
// `@coderline/alphatab`'s dist bundle: that package's `exports` map
// hides the font path from Vite's resolver, so we keep our own copy
// alongside the OFL license.

// `?url` returns the asset URL Vite produces for the woff2 file.
import bravuraUrl from "@/assets/fonts/Bravura.woff2?url";

let injected = false;

/** Idempotent. Call once at app startup. */
export function ensureBravuraLoaded(): void {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.setAttribute("data-bravura", "");
  style.textContent = `
    @font-face {
      font-family: "Bravura";
      src: url(${bravuraUrl}) format("woff2");
      font-display: block;
    }
  `;
  document.head.appendChild(style);
}

/**
 * SMuFL codepoints (Private Use Area) for musical rests. See
 * https://www.smufl.org/version/latest/range/rests/.
 */
export const SMUFL_REST: Record<
  "whole" | "half" | "quarter" | "eighth" | "sixteenth" | "thirtySecond" | "sixtyFourth",
  string
> = {
  whole: "\u{E4E3}", // restWhole — hangs below the line
  half: "\u{E4E4}", // restHalf — sits on the line
  quarter: "\u{E4E5}", // restQuarter
  eighth: "\u{E4E6}", // rest8th
  sixteenth: "\u{E4E7}", // rest16th
  thirtySecond: "\u{E4E8}", // rest32nd
  sixtyFourth: "\u{E4E9}", // rest64th
};
