// M7 — visual-context stats seam (rubric #1: accuracy of visual context).
//
// After a visual perception run, the panel records a NON-CONTENT aggregate on its own
// window: the content-analysis status and per-CATEGORY counts of OCR/vision findings.
// Deliberately NOT exposed: recognized text, bboxes, region ids, pixels — the agent
// never receives those either, so category counts are exactly the accuracy surface
// that matters. Value-free by construction (CLAUDE.md §5 Rule 4).

import type {
  SensitiveCategory,
  VisualContentStatus,
  VisualPerceptionResult,
} from '../types/contracts';

export interface VisualStatsSnapshot {
  contentStatus?: VisualContentStatus;
  categories: Partial<Record<SensitiveCategory, number>>;
  regionsProcessed: number;
  capturedAt: number;
}

declare global {
  interface Window {
    __PRIVAGENT_VISUAL__?: VisualStatsSnapshot;
  }
}

export function recordVisualStats(result: VisualPerceptionResult): void {
  const categories: Partial<Record<SensitiveCategory, number>> = {};
  for (const finding of result.contentFindings ?? []) {
    categories[finding.category] = (categories[finding.category] ?? 0) + 1;
  }
  window.__PRIVAGENT_VISUAL__ = {
    contentStatus: result.contentStatus,
    categories,
    regionsProcessed: result.metrics.regionsProcessed,
    capturedAt: Date.now(),
  };
}
