// PrivAgent content script.
// SECURITY: webpage content is UNTRUSTED (CLAUDE.md §6). This script never evaluates
// page-supplied strings and never returns raw markup. It answers a SCAN_PAGE request
// with only the structured inputs the local pipeline needs:
//   - `pageText`  : user-visible text (whole page + form-field values) for M2 detection
//                   and M5 redaction. Used INTERNALLY only; never rendered in the popup.
//   - `snapshot`  : M3 visual candidates (geometry + text-availability flags, no pixels).
// Capture and analysis themselves run in the side panel document, not here.

import { collectVisualCandidatesInPage } from '../perception/visual/collect-candidates';
import {
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  type ScanPageResponse,
  type ScrollViewportResponse,
} from '../types/messages';

/**
 * Gather the user-visible text surface M2 runs over: the whole page's rendered text
 * (`innerText`, which includes below-the-fold content and excludes hidden nodes) plus
 * the current values of visible form fields. Returns text only — never markup.
 */
function collectPageText(): string {
  const parts: string[] = [];

  const body = document.body;
  if (body !== null && typeof body.innerText === 'string') parts.push(body.innerText);

  const fields = document.querySelectorAll('input, textarea, select');
  for (const field of Array.from(fields)) {
    const value = (field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }

  return parts.join('\n');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === SCAN_PAGE) {
    try {
      sendResponse({
        pageText: collectPageText(),
        snapshot: collectVisualCandidatesInPage(),
      } satisfies ScanPageResponse);
    } catch {
      // Never forward an error message: it could echo page content. A fixed code only.
      sendResponse({ error: 'SCAN_FAILED' } satisfies ScanPageResponse);
    }
    return undefined; // responded synchronously
  }

  // Bounded below-the-fold band capture (M3): scroll to a requested document offset and
  // report the position actually reached. Geometry only — no page content crosses here.
  if (message?.type === SCROLL_VIEWPORT) {
    try {
      const top = typeof message.top === 'number' && Number.isFinite(message.top)
        ? Math.max(0, Math.floor(message.top))
        : 0;
      window.scrollTo({ top, left: window.scrollX, behavior: 'auto' });
      sendResponse({ scrollY: Math.max(0, Math.floor(window.scrollY)) } satisfies ScrollViewportResponse);
    } catch {
      sendResponse({ error: 'SCROLL_FAILED' } satisfies ScrollViewportResponse);
    }
    return undefined; // responded synchronously
  }

  return undefined;
});

export {};
