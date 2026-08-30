// M3 — bounded below-the-fold band planner (PURE; no I/O, no capture, no logging).
//
// `chrome.tabs.captureVisibleTab` only ever returns the CURRENT viewport; Chrome
// exposes no off-screen capture API. To inspect painted content below the fold we
// therefore capture the viewport at a few discrete scroll positions ("bands") — never
// a full-page screenshot, never continuous scrolling, never every scroll position.
//
// This module decides WHICH bands are worth capturing and WHERE each candidate lands
// within its band. It is deliberately conservative and bounded:
//   - only bands that actually contain a below-fold candidate are planned;
//   - at most MAX_BELOW_FOLD_BANDS extra bands, and a shared region budget, are used;
//   - each region is mapped to DOCUMENT-absolute coordinates (for M4/M5/summary) and to
//     a band-relative crop offset (for cropping that band's capture).
//
// If the host cannot scroll (no injected scroller), the service simply skips all of
// this and inspects only the visible viewport — below-fold IMAGES are then NOT covered,
// and that limitation is reported honestly rather than faked.

import type { DomVisualCandidate, DomVisualSnapshot, VisualRegion } from '../../types/contracts';
import { MIN_CANDIDATE_EDGE } from './decision';
import { MAX_REGIONS } from './regions';

/** Extra viewport captures allowed BELOW the initial viewport, per run. Bounds
 *  capture-rate pressure and CPU: the visible viewport is captured separately. */
export const MAX_BELOW_FOLD_BANDS = 3;

/** One below-fold region: where to crop it in its band capture, and its true
 *  document-absolute geometry for everything downstream. */
export interface BandRegion {
  /** Region in DOCUMENT coordinates (absolute y). Used for observation/M4/M5/summary. */
  region: VisualRegion;
  /** y within the band capture [0, viewportHeight). Used only to crop pixels. */
  cropY: number;
}

/** A single below-fold viewport capture at scroll offset `scrollY`. */
export interface CaptureBand {
  /** Document y to scroll the viewport to before capturing this band. */
  scrollY: number;
  regions: BandRegion[];
}

/** Horizontal clamp of a candidate rect into the viewport width, integer CSS px. */
function clampX(
  rect: DomVisualCandidate['rect'],
  vw: number,
): { x: number; width: number } | null {
  const left = Math.max(0, Math.floor(rect.x));
  const right = Math.min(vw, Math.ceil(rect.x + rect.width));
  const width = right - left;
  if (width < MIN_CANDIDATE_EDGE) return null;
  return { x: left, width };
}

/**
 * Plan bounded below-the-fold capture bands from the whole-document candidate set.
 *
 * A candidate is "below the fold" when its document-absolute top sits at or beyond the
 * bottom of the initially visible viewport. Each such candidate is assigned to the band
 * whose top is the nearest lower multiple of the viewport height, so one capture at that
 * offset shows it. Bands and total regions are hard-capped; the largest candidates win.
 *
 * @param budget max regions to plan across all below-fold bands (shared with the
 *               viewport regions the caller already selected).
 */
export function planBelowFoldBands(
  snapshot: DomVisualSnapshot,
  candidates: readonly DomVisualCandidate[],
  budget: number = MAX_REGIONS,
): CaptureBand[] {
  const vw = Math.max(0, Math.floor(snapshot.viewport?.width ?? 0));
  const vh = Math.max(0, Math.floor(snapshot.viewport?.height ?? 0));
  if (vw === 0 || vh === 0 || budget <= 0) return [];

  const scroll0 = Math.max(0, Math.floor(snapshot.scrollY ?? 0));
  const foldBottom = scroll0 + vh; // document y below which content is off-screen now

  // Collect below-fold regions in document coordinates, largest first.
  const planned: { docTop: number; region: VisualRegion; cropY: number; area: number }[] = [];
  for (const candidate of candidates) {
    const rect = candidate.rect;
    const docTop = Math.floor(rect.y) + scroll0;
    if (docTop < foldBottom) continue; // visible now → handled by the viewport pass

    const x = clampX(rect, vw);
    if (x === null) continue;

    // The band whose top is the largest multiple of vh not exceeding docTop.
    const bandScrollY = Math.floor(docTop / vh) * vh;
    const cropY = docTop - bandScrollY;
    // Fit the region inside this single band capture; anything spilling below is
    // clipped (bounded — we do not chase one region across multiple captures).
    const height = Math.min(Math.ceil(rect.height), vh - cropY);
    if (height < MIN_CANDIDATE_EDGE) continue;

    planned.push({
      docTop,
      cropY,
      area: x.width * height,
      region: { id: `r-b${bandScrollY}-${x.x}-${docTop}-${x.width}x${height}`, x: x.x, y: docTop, width: x.width, height },
    });
  }

  if (planned.length === 0) return [];
  planned.sort((a, b) => b.area - a.area || a.docTop - b.docTop);

  // Group the top-`budget` regions into their bands.
  const bands = new Map<number, BandRegion[]>();
  for (const item of planned.slice(0, budget)) {
    const scrollY = Math.floor(item.docTop / vh) * vh;
    const list = bands.get(scrollY) ?? [];
    list.push({ region: item.region, cropY: item.cropY });
    bands.set(scrollY, list);
  }

  return Array.from(bands.entries())
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_BELOW_FOLD_BANDS)
    .map(([scrollY, regions]) => ({
      scrollY,
      regions: regions.sort((a, b) => a.region.y - b.region.y || a.region.x - b.region.x),
    }));
}
