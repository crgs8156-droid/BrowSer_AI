// Page-side collection of visual candidates for M3.
//
// ⚠️ SERIALIZATION CONSTRAINT: `collectVisualCandidatesInPage` is passed to
// `chrome.scripting.executeScript({ func })`, which stringifies the function and
// re-evaluates it inside the page. It therefore MUST be entirely self-contained:
// no imports, no module-scope constants, no closure references. Type-only imports
// are safe because TypeScript erases them.
//
// This runs in an UNTRUSTED page (CLAUDE.md §6). It only reads geometry and
// text-availability flags; it never evaluates page-supplied strings and never
// returns pixels.

import type {
  DomVisualCandidate,
  DomVisualSnapshot,
  VisualCandidateKind,
} from '../../types/contracts';

export function collectVisualCandidatesInPage(): DomVisualSnapshot {
  const MIN_EDGE = 32;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const candidates: DomVisualCandidate[] = [];

  const nodes = Array.from(document.querySelectorAll('img, canvas, video, svg, iframe'));

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();

    // Too small to hold readable content.
    if (rect.width < MIN_EDGE || rect.height < MIN_EDGE) continue;

    // Entirely outside the visible viewport — a capture would not include it.
    if (
      rect.bottom <= 0 ||
      rect.right <= 0 ||
      rect.top >= viewport.height ||
      rect.left >= viewport.width
    ) {
      continue;
    }

    const style = window.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number.parseFloat(style.opacity) === 0) continue;

    const tag = node.tagName.toLowerCase();
    let kind: VisualCandidateKind = 'image';
    if (tag === 'canvas') kind = 'canvas';
    else if (tag === 'video') kind = 'video';
    else if (tag === 'svg') kind = 'svg';
    else if (tag === 'iframe') kind = 'iframe';

    const alt = (node.getAttribute('alt') ?? '').trim();
    const ariaLabel = (node.getAttribute('aria-label') ?? '').trim();
    const title = (node.getAttribute('title') ?? '').trim();
    const innerText = (node.textContent ?? '').trim();

    candidates.push({
      kind,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hasAccessibleText: alt.length > 0 || ariaLabel.length > 0 || title.length > 0,
      domTextLength: innerText.length,
      elementId: node.id.length > 0 ? node.id : undefined,
    });
  }

  const bodyText = document.body === null ? '' : (document.body.innerText ?? '');

  return {
    url: window.location.href,
    viewport,
    domTextLength: bodyText.trim().length,
    candidates,
  };
}
