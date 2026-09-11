// Phase 2 — Devanagari numeral normalization (SIH 2026 Hindi/regional PII).
//
// Devanagari digits U+0966–U+096F map 1:1 onto ASCII 0–9, so normalization is
// length-preserving: an index in the normalized copy addresses the same
// character in the original. Detectors run on the normalized copy and map
// matches back to original slices — the original text is never modified.

const DEVANAGARI_ZERO = 0x0966;
const DEVANAGARI_DIGITS = /[\u0966-\u096F]/g;

/** Replace Devanagari numerals with ASCII equivalents (identity on ASCII). */
export function normalizeNumerals(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(DEVANAGARI_DIGITS, (ch) => String(ch.charCodeAt(0) - DEVANAGARI_ZERO));
}
