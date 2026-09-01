// Region selection + bounding for M3.
//
// Enforces the "targeted, bounded, minimal resolution" rule: we never process a
// full page, never process more than MAX_REGIONS areas, and never analyse pixels
// at a higher resolution than the analysis actually needs.

import type { DomVisualCandidate, DomVisualSnapshot, VisualRegion } from '../../types/contracts';
import { MIN_CANDIDATE_EDGE } from './decision';

/** Hard cap on regions analysed per run — bounds CPU and memory. */
export const MAX_REGIONS = 4;
/** Analysis raster is downscaled so its longest edge is at most this many px. */
export const MAX_ANALYSIS_EDGE = 192;
/**
 * Analysis raster edge for regions that will also be fed to an OCR/vision CONTENT
 * analyzer: pattern recognition needs real pixel density, and the structural
 * `MAX_ANALYSIS_EDGE` budget shrinks 28px text to unreadable ~8px. Used ONLY when a
 * content analyzer is registered, so the default pipeline is unchanged.
 */
export const OCR_ANALYSIS_EDGE = 1024;

/** Clamp a candidate rect into the visible viewport, in integer CSS pixels. */
function clampToViewport(
  rect: DomVisualCandidate['rect'],
  viewport: DomVisualSnapshot['viewport'],
): { x: number; y: number; width: number; height: number } | null {
  const vw = Math.max(0, Math.floor(viewport?.width ?? 0));
  const vh = Math.max(0, Math.floor(viewport?.height ?? 0));
  if (vw === 0 || vh === 0) return null;

  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(vw, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(vh, Math.ceil(rect.y + rect.height));

  const width = right - left;
  const height = bottom - top;
  if (width < MIN_CANDIDATE_EDGE || height < MIN_CANDIDATE_EDGE) return null;

  return { x: left, y: top, width, height };
}

/**
 * Turn accepted candidates into a bounded, deterministic set of regions.
 * Off-screen and sub-threshold candidates are dropped; the largest informative
 * regions win. Ordering is stable so caching is reproducible across runs.
 */
export function selectRegions(
  snapshot: DomVisualSnapshot,
  candidates: readonly DomVisualCandidate[],
): VisualRegion[] {
  const clamped: { x: number; y: number; width: number; height: number }[] = [];

  for (const candidate of candidates) {
    const rect = clampToViewport(candidate.rect, snapshot.viewport);
    if (rect !== null) clamped.push(rect);
  }

  clamped.sort((a, b) => {
    const areaDelta = b.width * b.height - a.width * a.height;
    if (areaDelta !== 0) return areaDelta;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  return clamped.slice(0, MAX_REGIONS).map((rect) => ({
    id: `r-${rect.x}-${rect.y}-${rect.width}x${rect.height}`,
    ...rect,
  }));
}

/** Downscale factor keeping the longest edge within `maxEdge`. Never upscales. */
export function analysisScale(
  width: number,
  height: number,
  maxEdge: number = MAX_ANALYSIS_EDGE,
): number {
  const longest = Math.max(width, height);
  if (longest <= 0 || longest <= maxEdge) return 1;
  return maxEdge / longest;
}
