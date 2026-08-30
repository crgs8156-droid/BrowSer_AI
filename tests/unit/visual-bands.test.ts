// M3 — unit tests for the pure below-the-fold band planner (`planBelowFoldBands`).
//
// The planner decides WHICH bounded viewport captures are worth taking below the fold,
// and maps each candidate to (a) document-absolute geometry for downstream M4/M5/summary
// and (b) a band-relative crop offset for cropping that band's capture. It never captures
// or scrolls; it only plans. These tests pin its boundedness and coordinate math.

import { describe, expect, it } from 'vitest';
import {
  planBelowFoldBands,
  MAX_BELOW_FOLD_BANDS,
} from '../../extension/src/perception/visual/bands';
import { MAX_REGIONS } from '../../extension/src/perception/visual/regions';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';

function candidate(overrides: Partial<DomVisualCandidate> = {}): DomVisualCandidate {
  return {
    kind: 'image',
    rect: { x: 0, y: 0, width: 300, height: 200 },
    hasAccessibleText: false,
    domTextLength: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DomVisualSnapshot> = {}): DomVisualSnapshot {
  return {
    url: 'https://example.test/page',
    viewport: { width: 1280, height: 800 },
    domTextLength: 4000,
    candidates: [],
    scrollY: 0,
    ...overrides,
  };
}

describe('planBelowFoldBands', () => {
  it('ignores candidates already visible in the initial viewport', () => {
    const bands = planBelowFoldBands(
      snapshot({ candidates: [candidate({ rect: { x: 0, y: 100, width: 300, height: 200 } })] }),
      [candidate({ rect: { x: 0, y: 100, width: 300, height: 200 } })],
    );
    expect(bands).toEqual([]);
  });

  it('maps a single below-fold candidate to its band with correct doc + crop coords', () => {
    // vh = 800. A candidate at viewport-y 900 with scrollY 0 sits at docTop 900 → band 800.
    const cand = candidate({ rect: { x: 40, y: 900, width: 300, height: 200 } });
    const bands = planBelowFoldBands(snapshot({ candidates: [cand] }), [cand]);

    expect(bands).toHaveLength(1);
    const band = bands[0]!;
    expect(band.scrollY).toBe(800);
    expect(band.regions).toHaveLength(1);
    const bandRegion = band.regions[0]!;
    // Document-absolute geometry (what M4/M5/summary see).
    expect(bandRegion.region.y).toBe(900);
    expect(bandRegion.region.x).toBe(40);
    // Crop offset within the band capture (docTop - bandScrollY).
    expect(bandRegion.cropY).toBe(100);
  });

  it('accounts for the current scroll offset when computing document position', () => {
    // scrollY 500, candidate at viewport-y 400 → docTop 900 → below fold (fold = 500+800).
    // Wait: fold bottom is 500+800=1300; docTop 900 < 1300 ⇒ still visible. Use y 1000.
    const cand = candidate({ rect: { x: 0, y: 1000, width: 300, height: 200 } });
    const bands = planBelowFoldBands(snapshot({ scrollY: 500, candidates: [cand] }), [cand]);
    // docTop = 1000 + 500 = 1500 ≥ fold 1300 ⇒ planned. band = floor(1500/800)*800 = 800.
    expect(bands).toHaveLength(1);
    expect(bands[0]!.regions[0]!.region.y).toBe(1500);
  });

  it('groups multiple candidates that land in the same band into one capture', () => {
    const a = candidate({ rect: { x: 0, y: 850, width: 300, height: 100 } }); // docTop 850 → band 800
    const b = candidate({ rect: { x: 400, y: 1000, width: 300, height: 100 } }); // docTop 1000 → band 800
    const bands = planBelowFoldBands(snapshot({ candidates: [a, b] }), [a, b]);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.scrollY).toBe(800);
    expect(bands[0]!.regions).toHaveLength(2);
  });

  it('separates candidates that fall into different bands', () => {
    const a = candidate({ rect: { x: 0, y: 850, width: 300, height: 100 } }); // band 800
    const b = candidate({ rect: { x: 0, y: 1700, width: 300, height: 100 } }); // docTop 1700 → band 1600
    const bands = planBelowFoldBands(snapshot({ candidates: [a, b] }), [a, b]);
    expect(bands).toHaveLength(2);
    expect(bands.map((band) => band.scrollY)).toEqual([800, 1600]);
  });

  it('caps the number of bands at MAX_BELOW_FOLD_BANDS (honest, no silent overflow)', () => {
    // One candidate in each of 5 distinct bands (900, 1700, 2500, 3300, 4100).
    const cands = [900, 1700, 2500, 3300, 4100].map((y) =>
      candidate({ rect: { x: 0, y, width: 300, height: 60 } }),
    );
    const bands = planBelowFoldBands(snapshot({ candidates: cands }), cands, cands.length);
    expect(bands.length).toBeLessThanOrEqual(MAX_BELOW_FOLD_BANDS);
  });

  it('honours the shared region budget, keeping the largest candidates first', () => {
    const small = candidate({ rect: { x: 0, y: 900, width: 60, height: 60 } });
    const large = candidate({ rect: { x: 0, y: 1000, width: 600, height: 400 } });
    const bands = planBelowFoldBands(snapshot({ candidates: [small, large] }), [small, large], 1);
    const total = bands.reduce((n, band) => n + band.regions.length, 0);
    expect(total).toBe(1);
    // The larger-area candidate wins the single slot.
    expect(bands[0]!.regions[0]!.region.width).toBe(600);
  });

  it('returns nothing when the budget is zero or the viewport is degenerate', () => {
    const cand = candidate({ rect: { x: 0, y: 900, width: 300, height: 200 } });
    expect(planBelowFoldBands(snapshot({ candidates: [cand] }), [cand], 0)).toEqual([]);
    expect(
      planBelowFoldBands(snapshot({ viewport: { width: 0, height: 0 }, candidates: [cand] }), [cand]),
    ).toEqual([]);
  });

  it('clips a region that would spill past the band and drops it if too short', () => {
    // Candidate near the very bottom of its band: docTop 1590 (band 800), vh 800 ⇒ crop 790,
    // only 10px remain in the band → below MIN_CANDIDATE_EDGE (32) → dropped.
    const cand = candidate({ rect: { x: 0, y: 1590, width: 300, height: 400 } });
    const bands = planBelowFoldBands(snapshot({ candidates: [cand] }), [cand]);
    expect(bands).toEqual([]);
  });

  it('defaults the budget to MAX_REGIONS', () => {
    const cands = Array.from({ length: 10 }, (_, i) =>
      candidate({ rect: { x: 0, y: 900 + i * 10, width: 300, height: 60 } }),
    );
    const bands = planBelowFoldBands(snapshot({ candidates: cands }), cands);
    const total = bands.reduce((n, band) => n + band.regions.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REGIONS);
  });
});
