// Reveal helper — pure, testable masking for session values.
// Values live only in the panel's memory (vault wrapper), never in telemetry/audit.
// Masked default: first-char + ••• (+ @••• for emails), click-to-unmask per row.

export interface RevealEntry {
  alias: string;
  category: string;
  value: string;
}

export interface RevealRow extends RevealEntry {
  masked: string;
}

export function maskValue(value: string): string {
  if (!value) return "•••";
  const at = value.indexOf("@");
  if (at > 0) {
    // email-like: u•••@•••  (first char + ••• + @ + •••)
    return `${value[0]}•••@•••`;
  }
  if (value.length <= 2) return "•••";
  // generic: first + ••• + last
  return `${value[0]}•••${value[value.length - 1]}`;
}

export function toRevealRows(entries: RevealEntry[]): RevealRow[] {
  return entries.map((e) => ({ ...e, masked: maskValue(e.value) }));
}
