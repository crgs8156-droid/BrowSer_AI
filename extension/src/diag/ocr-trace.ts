// OCR-capture pipeline tracer.
//
// A SINGLE, privacy-safe chokepoint for the stage-by-stage diagnostics that let a
// developer see exactly where the visual/OCR path stops producing regions in a real
// browser (capture refused? pixels invalid? engine unavailable? no text recognized?).
//
// PRIVACY (CONTRIBUTING.md §5 Rule 4, §22): this logger MUST NEVER receive raw protected
// content. Its `detail` type admits only numbers, booleans, and short enum-like strings
// (stage codes, region ids, category names, reason codes) — never recognized OCR text,
// page text, pixels, or a capture data URL. Callers pass counts/dimensions/ids only.
//
// It is deliberately not gated behind a flag: the whole point is that a developer can
// open the side-panel console on a live page and read the trace. Nothing it prints is
// sensitive, and it prints via `console.info`/`console.warn` (never `console.error`, so
// it cannot trip the "no console errors" smoke check) under one greppable prefix.

/** Ordered stages of the capture → OCR → findings → UI path. */
export type OcrTraceStage =
  | 'SELECTED_PAGE'
  | 'CAPTURE_REQUESTED'
  | 'CAPTURE_SUCCESS'
  | 'CAPTURE_FAILED'
  | 'PIXEL_DATA_VALID'
  | 'OCR_STARTED'
  | 'OCR_RESULT'
  | 'OCR_REGION_COUNT'
  | 'PRIVACY_FINDINGS'
  | 'UI_FINDINGS';

/** Only non-content scalars are loggable — enforced by the type, not by convention. */
export type SafeDetail = Record<string, number | boolean | string | undefined>;

const PREFIX = '[PrivAgent OCR]';

/** Stages that represent a soft failure/degradation → warn (never error). */
const WARN_STAGES: ReadonlySet<OcrTraceStage> = new Set<OcrTraceStage>(['CAPTURE_FAILED']);

/**
 * Emit one pipeline stage with safe metadata. `detail` is typed to reject objects,
 * arrays, and any nested content, so a raw value cannot be logged even by mistake.
 */
export function ocrTrace(stage: OcrTraceStage, detail: SafeDetail = {}): void {
  if (typeof console === 'undefined') return;
  const line = `${PREFIX} ${stage}`;
  if (WARN_STAGES.has(stage)) {
    console.warn(line, detail);
  } else {
    console.info(line, detail);
  }
}
