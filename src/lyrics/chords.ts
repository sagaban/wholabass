/**
 * Chord name parsing + transposition for the lyrics panel.
 *
 * Supports both English notation (A-G with #/b accidentals) and
 * Spanish/Italian solfège (Do, Re, Mi, Fa, Sol, La, Si — also with
 * #/b). Transposition preserves the input notation style and tries
 * to keep the accidental direction (sharp / flat) consistent with
 * the surrounding song so a transposed `Bb Eb Ab` doesn't come back
 * as `B# D# G#`.
 *
 * Stored lyrics text is never mutated — only the rendered view is
 * transposed, so flipping the pitch back to 0 restores the user's
 * original chord spellings exactly.
 */

const EN_ROOT_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const SOL_ROOT_PC: Record<string, number> = {
  Do: 0,
  Re: 2,
  Mi: 4,
  Fa: 5,
  Sol: 7,
  La: 9,
  Si: 11,
};

// Pitch-class → name lookups. Indexed 0..11 from C/Do upward.
const SHARP_EN = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_EN = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const SHARP_SOL = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
const FLAT_SOL = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"];

const ROOT_HEAD = /^(Do|Re|Mi|Fa|Sol|La|Si|[A-G])([#♯b♭]?)/;

/** Decomposed root. Style preserved so re-encoding stays in the same notation. */
interface ParsedRoot {
  /** Pitch class 0..11 (C / Do = 0). */
  pc: number;
  /** True when the input root was a solfège syllable. */
  isSolfege: boolean;
  /** "#" / "♯" / "b" / "♭" or "" — used to bias the global flat-preference scan. */
  accidental: string;
  /** Length of the root match in the original token, for splicing. */
  matchLen: number;
}

function parseRoot(token: string): ParsedRoot | null {
  const m = ROOT_HEAD.exec(token);
  if (!m) return null;
  const root = m[1];
  const accidental = m[2];
  const isSolfege = root.length > 1;
  const basePc = isSolfege ? SOL_ROOT_PC[root] : EN_ROOT_PC[root];
  if (basePc === undefined) return null;
  let pc = basePc;
  if (accidental === "#" || accidental === "♯") pc = (pc + 1) % 12;
  else if (accidental === "b" || accidental === "♭") pc = (pc + 11) % 12;
  return { pc, isSolfege, accidental, matchLen: m[0].length };
}

function renderRoot(pc: number, isSolfege: boolean, preferFlats: boolean): string {
  const table = isSolfege ? (preferFlats ? FLAT_SOL : SHARP_SOL) : preferFlats ? FLAT_EN : SHARP_EN;
  return table[((pc % 12) + 12) % 12];
}

/**
 * Transpose a single chord token by `semitones`. Handles a slash-bass
 * anywhere in the suffix (e.g. `G/B` → `A/C#`, `Am7/G` → `Bm7/A`) by
 * locating the `/`, transposing the root segment on either side, and
 * splicing the result back together. Returns the input verbatim if
 * the leading root doesn't parse — keeps random non-chord-but-regex-
 * matched strings safe.
 */
export function transposeChord(token: string, semitones: number, preferFlats: boolean): string {
  if (semitones === 0) return token;
  const parsed = parseRoot(token);
  if (!parsed) return token;
  const newPc = (((parsed.pc + semitones) % 12) + 12) % 12;
  const newRoot = renderRoot(newPc, parsed.isSolfege, preferFlats);
  let rest = token.slice(parsed.matchLen);

  // Slash-bass: locate the "/" within the suffix (after `m7`, `maj7`,
  // etc.) and transpose whatever root follows it. The slash isn't
  // required to be at the start of `rest` — `Am7/G` has `m7` before
  // the slash.
  const slashIdx = rest.indexOf("/");
  if (slashIdx >= 0) {
    const before = rest.slice(0, slashIdx);
    const tail = rest.slice(slashIdx + 1);
    const bass = parseRoot(tail);
    if (bass) {
      const bassPc = (((bass.pc + semitones) % 12) + 12) % 12;
      const newBass = renderRoot(bassPc, bass.isSolfege, preferFlats);
      rest = before + "/" + newBass + tail.slice(bass.matchLen);
    }
  }

  return newRoot + rest;
}

/**
 * Decide whether transposed chord names should favour flats or sharps,
 * by scanning the entire lyrics block for `b` / `#` accidentals across
 * every chord-shaped token (including slash basses). Whole-song scope
 * keeps the choice consistent within the panel — a single mixed song
 * picks the majority direction once.
 *
 * Tied / no-accidental songs default to **flats**, which lines up with
 * how bassists usually name keys ("Eb", "Ab", "Bb").
 */
export function preferFlatsForLyrics(lyrics: string): boolean {
  let flats = 0;
  let sharps = 0;
  // Same pattern as ROOT_HEAD but global with surrounding word
  // boundaries so we catch the head of every chord token.
  const re = /\b(?:Do|Re|Mi|Fa|Sol|La|Si|[A-G])([#♯b♭])/g;
  for (const m of lyrics.matchAll(re)) {
    const a = m[1];
    if (a === "#" || a === "♯") sharps++;
    else flats++;
  }
  // Slash basses also count, but they share the same regex above.
  return flats >= sharps;
}
