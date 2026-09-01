// Page-side collection of visual candidates for M3.
//
// ⚠️ SERIALIZATION CONSTRAINT: `collectVisualCandidatesInPage` is passed to
// `chrome.scripting.executeScript({ func })`, which stringifies the function and
// re-evaluates it inside the page. It therefore MUST be entirely self-contained:
// no imports, no module-scope constants, no closure references. Type-only imports
// are safe because TypeScript erases them.
//
// This runs in an UNTRUSTED page (CONTRIBUTING.md §6). It only reads geometry and
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

    // Cull only what a capture can NEVER reach: content above the current viewport,
    // or off to either side. Content BELOW the fold is intentionally KEPT — the service
    // may cover it with bounded below-the-fold band captures (it maps these rects to
    // document coordinates using `scrollY`). Nodes already scrolled past (bottom <= 0)
    // cannot be recaptured without scrolling up, so they are dropped.
    if (
      rect.bottom <= 0 ||
      rect.right <= 0 ||
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

  const docEl = document.documentElement;
  const documentHeight =
    docEl === null ? viewport.height : Math.max(docEl.scrollHeight, viewport.height);

  return {
    url: window.location.href,
    viewport,
    domTextLength: bodyText.trim().length,
    candidates,
    // Document-absolute mapping inputs for bounded below-the-fold band capture. The
    // candidate rects above stay viewport-relative; the service adds `scrollY` to them.
    scrollY: Math.max(0, Math.floor(window.scrollY)),
    documentHeight,
  };
}
