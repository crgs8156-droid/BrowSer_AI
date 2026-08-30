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

/**
 * Run a full privacy scan of the active tab. The in-page collector returns only the
 * structured inputs the local pipeline (M2 PII + M3 visual + M4 policy + M5 enforce)
 * needs — never raw markup. `pageText` is user-visible text used INTERNALLY only (it
 * is fed to detection/sanitization and never rendered); the popup consumes the derived,
 * sanitized `ScanSummary`, not this payload.
 */
export const SCAN_PAGE = 'SCAN_PAGE';

export interface ScanPageResponse {
  /**
   * The page's user-visible text (whole page incl. below-fold `innerText`, plus visible
   * form-field values) — the surface M2 detection runs over. Internal only; never
   * markup, never rendered in the UI.
   */
  pageText?: string;
  /** M3 visual-candidate snapshot: geometry + text-availability flags only, no pixels. */
  snapshot?: DomVisualSnapshot | null;
  /** Set when the browser forbids scanning this surface (fail closed). */
  restricted?: boolean;
  /** Non-sensitive diagnostic code only — never page content or error text. */
  error?: string;
}

/**
 * Scroll the active tab's viewport to document y `top`, for BOUNDED below-the-fold band
 * capture (M3). `captureVisibleTab` only ever returns the current viewport, and Chrome
 * exposes no off-screen capture API, so covering below-fold IMAGES requires scrolling to
 * a few discrete offsets and capturing each. The content script scrolls, lets layout
 * settle, and reports the position actually reached (`scrollY`) — geometry only, never
 * page content. The side panel restores the original offset when the scan finishes.
 */
export const SCROLL_VIEWPORT = 'SCROLL_VIEWPORT';

export interface ScrollViewportResponse {
  /** Document y actually reached after scrolling (may be clamped by the page). */
  scrollY?: number;
  /** Non-sensitive diagnostic code only — never page content or error text. */
  error?: string;
}

/**
 * Capture the active tab's CURRENTLY VISIBLE viewport as a PNG data URL (M3).
 *
 * WHY THE BACKGROUND, NOT THE PANEL: `chrome.tabs.captureVisibleTab` needs an explicit,
 * correctly-resolved window. From a side-panel document `WINDOW_ID_CURRENT` does not
 * reliably resolve to the browser window that holds the web page, so a panel-side call
 * fails with `VISUAL_CAPTURE_UNAVAILABLE` even on an ordinary page. The background worker
 * already resolves the active tab (and its `windowId`) reliably — the same path SCAN_PAGE
 * uses — so capture is brokered here and only the resulting data URL is returned to the
 * panel, which then rasterizes/crops LOCALLY. The data URL never leaves the device.
 */
export const CAPTURE_VIEWPORT = 'CAPTURE_VIEWPORT';

export interface CaptureViewportResponse {
  /** PNG data URL of the visible viewport. Local only — never sent to any remote. */
  dataUrl?: string;
  /** Set when the browser forbids capturing this surface (fail closed). */
  restricted?: boolean;
  /**
   * Short, non-sensitive diagnostic. Either a structured code (e.g. NO_ACTIVE_TAB) or the
   * Chrome API's own capture-failure string (an API diagnostic, never pixels/page text) so
   * the cause of a VISUAL_CAPTURE_UNAVAILABLE is visible in the trace.
   */
  error?: string;
}
