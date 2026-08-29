// M3 DOM-first sufficiency check: decides whether visual perception is needed AT ALL.
//
// CONTENT-DRIVEN, NOT WEBSITE-DRIVEN. There is no site list, no domain matching and
// no URL inspection here. The decision uses only cheap structural facts already
// available from the DOM:
//
//   - does the DOM already expose this content as text?  → visual work is wasted
//   - is there a large painted surface the DOM cannot describe? → visual work may help
//
// The default answer is NO. Visual perception is opt-in per page, per region.

import type { DomVisualCandidate, DomVisualSnapshot } from '../../types/contracts';
import type { VisualDecision } from './types';

/** Below this area a candidate is decorative (icons, spacers, tracking pixels). */
export const MIN_CANDIDATE_AREA = 64 * 64;
/** Both edges must clear this, so 1000x2 banners don't qualify on area alone. */
export const MIN_CANDIDATE_EDGE = 32;
/** Under this much DOM text a page is not meaningfully readable via the DOM. */
export const SPARSE_DOM_TEXT_CHARS = 200;
/** Painted-surface share of the viewport that makes a text-sparse page suspect. */
export const PAINTED_AREA_RATIO = 0.15;

function area(candidate: DomVisualCandidate): number {
  return Math.max(0, candidate.rect.width) * Math.max(0, candidate.rect.height);
}

/**
 * A candidate carries information the DOM cannot reach when it is big enough to
 * hold readable content AND the DOM offers no text for it (no alt/aria/title and
 * no inner text). Anything the DOM can already describe is skipped.
 */
function isVisualOnly(candidate: DomVisualCandidate): boolean {
  return (
    candidate.rect.width >= MIN_CANDIDATE_EDGE &&
    candidate.rect.height >= MIN_CANDIDATE_EDGE &&
    area(candidate) >= MIN_CANDIDATE_AREA &&
    !candidate.hasAccessibleText &&
    candidate.domTextLength === 0
  );
}

/**
 * Decide whether to spend any capture/analysis budget on this page.
 * Malformed or empty snapshots resolve to `not required` — never to an attempt.
 */
export function decideVisualPerception(snapshot: DomVisualSnapshot): VisualDecision {
  const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  if (candidates.length === 0) {
    return { required: false, reason: 'no_visual_candidates', candidates: [] };
  }

  const visualOnly = candidates.filter(isVisualOnly);
  if (visualOnly.length > 0) {
    return { required: true, reason: 'visual_only_content_present', candidates: visualOnly };
  }

  // Fallback: a canvas/WebGL-rendered app can paint a whole screen of information
  // while exposing almost no DOM text. Judged by measured geometry, not by site.
  const domTextLength = typeof snapshot.domTextLength === 'number' ? snapshot.domTextLength : 0;
  const viewportArea =
    Math.max(0, snapshot.viewport?.width ?? 0) * Math.max(0, snapshot.viewport?.height ?? 0);

  if (domTextLength < SPARSE_DOM_TEXT_CHARS && viewportArea > 0) {
    const paintedArea = candidates.reduce((sum, candidate) => sum + area(candidate), 0);
    if (paintedArea / viewportArea >= PAINTED_AREA_RATIO) {
      return {
        required: true,
        reason: 'dom_text_insufficient_for_painted_area',
        candidates: candidates.filter((candidate) => area(candidate) >= MIN_CANDIDATE_AREA),
      };
    }
  }

  return { required: false, reason: 'dom_sufficient', candidates: [] };
}
