// Runtime message contracts shared between the background worker and the side panel.
// Kept separate from contracts.ts, which is types-only, because these are values.

import type { DomVisualSnapshot } from './contracts';

/** M3 — request cheap DOM visual-candidate metadata for the active tab. */
export const COLLECT_VISUAL_CANDIDATES = 'COLLECT_VISUAL_CANDIDATES';

export interface VisualCandidatesResponse {
  snapshot?: DomVisualSnapshot | null;
  /** Set when the browser forbids perception on this page. */
  restricted?: boolean;
  /** Non-sensitive diagnostic code only — never page content or error text. */
  error?: string;
}
