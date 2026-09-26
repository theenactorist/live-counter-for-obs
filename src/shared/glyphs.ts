// Glyph-coverage check (Task 3.0, AC 31) — the bundled fonts (Inter, Oswald;
// see src/dock/views/setup.ts's FONTS and src/styles/fonts.css) are both
// served from Google Fonts, subset to its published latin range. A label
// character outside that range still gets DRAWN by the browser (it falls
// back to whatever system font covers it), so this is a warning, never a
// validation failure — Setup never blocks Save/Start/Update on it (see the
// `setup-glyph-warning` render site).
//
// Ranges below are the exact `unicode-range: U+0000-00FF, U+0131, U+0152-0153,
// U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122,
// U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD` Google Fonts publishes for
// its `latin` subset — copied verbatim rather than approximated, so this
// module can never silently drift from what the fonts actually cover.
interface CodepointRange {
  lo: number;
  hi: number;
}

const LATIN_RANGES: readonly CodepointRange[] = [
  { lo: 0x0000, hi: 0x00ff },
  { lo: 0x0131, hi: 0x0131 },
  { lo: 0x0152, hi: 0x0153 },
  { lo: 0x02bb, hi: 0x02bc },
  { lo: 0x02c6, hi: 0x02c6 },
  { lo: 0x02da, hi: 0x02da },
  { lo: 0x02dc, hi: 0x02dc },
  { lo: 0x2000, hi: 0x206f },
  { lo: 0x2074, hi: 0x2074 },
  { lo: 0x20ac, hi: 0x20ac },
  { lo: 0x2122, hi: 0x2122 },
  { lo: 0x2191, hi: 0x2191 },
  { lo: 0x2193, hi: 0x2193 },
  { lo: 0x2212, hi: 0x2212 },
  { lo: 0x2215, hi: 0x2215 },
  { lo: 0xfeff, hi: 0xfeff },
  { lo: 0xfffd, hi: 0xfffd },
];

function isCovered(codePoint: number): boolean {
  return LATIN_RANGES.some((r) => codePoint >= r.lo && codePoint <= r.hi);
}

/**
 * Every character in `text` the bundled fonts' latin subset does NOT cover,
 * unique and in first-appearance order. Iterates by CODE POINT (`for...of`
 * a string), not UTF-16 code unit, so a character outside the Basic
 * Multilingual Plane (a surrogate pair) is checked — and reported — as the
 * one character it actually is, never as two mismatched halves.
 */
export function unsupportedGlyphs(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined || isCovered(codePoint) || seen.has(ch)) continue;
    seen.add(ch);
    result.push(ch);
  }
  return result;
}
