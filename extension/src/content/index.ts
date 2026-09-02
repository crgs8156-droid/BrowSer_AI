// PrivAgent content script.
// SECURITY: webpage content is UNTRUSTED (CONTRIBUTING.md §6). This script never evaluates
// page-supplied strings and never returns raw markup. It answers a SCAN_PAGE request
// with only the structured inputs the local pipeline needs:
//   - `pageText`  : user-visible text (whole page + form-field values) for M2 detection
//                   and M5 redaction. Used INTERNALLY only; never rendered in the popup.
//   - `snapshot`  : M3 visual candidates (geometry + text-availability flags, no pixels).
// Capture and analysis themselves run in the side panel document, not here.

import { collectVisualCandidatesInPage } from '../perception/visual/collect-candidates';
import {
  EXECUTE_ACTION,
  SCAN_PAGE,
  SCROLL_VIEWPORT,
  type ExecuteActionResponse,
  type FieldStructure,
  type ScanPageResponse,
  type ScrollViewportResponse,
} from '../types/messages';
import type { AgentAction } from '../types/contracts';

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

/** Escape a value for use inside a CSS attribute selector (`[name="…"]`). */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a deterministic CSS selector for an element: `#id` when it has an id,
 * `[name="…"]` when it has a name, otherwise inject a `data-priv-idx` attribute so the
 * selector survives until execution. The selector is the ONLY targeting mechanism —
 * the agent never receives element handles or markup.
 */
function selectorFor(el: Element, fallbackIndex: number): string {
  const id = el.id;
  if (id) return `#${CSS.escape(id)}`;
  const name = el.getAttribute('name');
  if (name) return `[name="${escapeAttr(name)}"]`;
  el.setAttribute('data-priv-idx', String(fallbackIndex));
  return `[data-priv-idx="${fallbackIndex}"]`;
}

/** Associated label / aria-label / placeholder / field name — the best text hint available. */
function labelFor(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | undefined {
  if (el.id) {
    const label = document.querySelector(`label[for="${escapeAttr(el.id)}"]`);
    const text = label?.textContent?.trim();
    if (text) return text.slice(0, 120);
  }
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria.slice(0, 120);
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  if (placeholder) return placeholder.slice(0, 120);
  const name = el.getAttribute('name')?.trim();
  if (name) return name.slice(0, 120);
  return undefined;
}

/**
 * Collect per-control structure for the M6 agent loop. Values here are RAW and the
 * response is INTERNAL ONLY (same boundary as `pageText`): the loop sanitizes this into
 * `SanitizedNode`s — filled booleans + detection-gated labels — before anything can be
 * considered for egress. Buttons are included so the planner can find submit controls.
 */
function collectFieldStructure(): FieldStructure[] {
  const out: FieldStructure[] = [];
  const nodes = document.querySelectorAll('input, textarea, select, button');
  let fallback = 0;

  for (const el of Array.from(nodes)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const inputType = (el as HTMLInputElement).type;
      if (inputType === 'hidden' || inputType === 'submit' || inputType === 'button') continue;
    }
    if (tag === 'button') {
      const buttonType = (el as HTMLButtonElement).type;
      if (buttonType === 'reset') continue;
    }
    if (!el.checkVisibility?.({ checkVisibilityCSS: true }) && (el as HTMLElement).offsetParent === null) {
      // Invisible controls are noise for the planner; skip rather than mislead it.
      continue;
    }

    const selector = selectorFor(el, fallback++);
    const structure: FieldStructure = { tag: tag as FieldStructure['tag'], selector, disabled: (el as HTMLButtonElement).disabled };
    if (el.getBoundingClientRect().top >= window.innerHeight) structure.belowFold = true;

    if (el.id) structure.id = el.id;
    const name = el.getAttribute('name') ?? undefined;
    if (name) structure.name = name;

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const field = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (tag === 'input') structure.inputType = (field as HTMLInputElement).type;
      const label = labelFor(field);
      if (label) structure.label = label;
      const value = field.value;
      if (typeof value === 'string' && value.length > 0) structure.value = value;
    } else {
      const text = el.textContent?.trim();
      if (text) structure.label = text.slice(0, 120);
    }

    out.push(structure);
  }

  return out;
}

/** True when the element is attached, rendered, and interactable. */
function isInteractable(el: Element): boolean {
  if (!el.isConnected) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Execute one structured agent action. The action was validated and its `TYPE` value
 * resolved (alias → real value) BEFORE reaching this script; the resolved value transits
 * only the LOCAL extension messaging channel. No page-supplied string is ever evaluated,
 * and no arbitrary code runs (CONTRIBUTING.md §6/§7).
 */
function executeActionInPage(action: AgentAction): ExecuteActionResponse {
  if (action.action === 'SCROLL') {
    window.scrollBy({ top: action.amount, left: 0, behavior: 'auto' });
    return { ok: true, code: 'OK' };
  }

  if (action.action === 'NAVIGATE') {
    // Policy validation (allowlist) already approved this URL before it got here.
    // Respond FIRST, then navigate: the reply channel dies with the old document.
    setTimeout(() => window.location.assign(action.url), 0);
    return { ok: true, code: 'OK' };
  }

  const el = document.querySelector(action.target);
  if (!el) return { ok: false, code: 'NOT_FOUND' };
  if (!isInteractable(el)) return { ok: false, code: 'NOT_VISIBLE' };

  if (action.action === 'CLICK') {
    if ((el as HTMLButtonElement).disabled) return { ok: false, code: 'DISABLED' };
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return { ok: true, code: 'OK' };
  }

  if (action.action === 'TYPE') {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.disabled || el.readOnly) return { ok: false, code: 'DISABLED' };
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      el.value = action.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'UNSUPPORTED' };
  }

  if (action.action === 'SELECT') {
    if (el instanceof HTMLSelectElement) {
      if (el.disabled) return { ok: false, code: 'DISABLED' };
      el.scrollIntoView({ block: 'center', behavior: 'auto' });
      const option = Array.from(el.options).find((o) => o.value === action.value);
      if (!option) return { ok: false, code: 'NO_SUCH_OPTION' };
      el.value = action.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, code: 'OK' };
    }
    return { ok: false, code: 'UNSUPPORTED' };
  }

  return { ok: false, code: 'UNSUPPORTED' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === SCAN_PAGE) {
    try {
      sendResponse({
        pageText: collectPageText(),
        snapshot: collectVisualCandidatesInPage(),
        structure: collectFieldStructure(),
      } satisfies ScanPageResponse);
    } catch {
      // Never forward an error message: it could echo page content. A fixed code only.
      sendResponse({ error: 'SCAN_FAILED' } satisfies ScanPageResponse);
    }
    return undefined; // responded synchronously
  }

  if (message?.type === EXECUTE_ACTION) {
    try {
      sendResponse(executeActionInPage(message.action as AgentAction) satisfies ExecuteActionResponse);
    } catch {
      // Never forward an error message: it could echo page content. A fixed code only.
      sendResponse({ ok: false, code: 'EXEC_FAILED' } satisfies ExecuteActionResponse);
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
