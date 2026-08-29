// M3 — region bounding, capping, and minimal-resolution scaling.

import { describe, expect, it } from 'vitest';
import {
  MAX_ANALYSIS_EDGE,
  MAX_REGIONS,
  analysisScale,
  selectRegions,
} from '../../extension/src/perception/visual/regions';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';

const snapshot: DomVisualSnapshot = {
  url: 'https://example.test/',
  viewport: { width: 1000, height: 800 },
  domTextLength: 0,
  candidates: [],
};

function candidate(x: number, y: number, width: number, height: number): DomVisualCandidate {
  return { kind: 'image', rect: { x, y, width, height }, hasAccessibleText: false, domTextLength: 0 };
}

describe('selectRegions', () => {
  it('caps the number of analysed regions', () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate(i * 10, i * 10, 200, 200));
    expect(selectRegions(snapshot, many)).toHaveLength(MAX_REGIONS);
  });

  it('keeps the largest regions first and is deterministic', () => {
    const regions = selectRegions(snapshot, [
      candidate(0, 0, 100, 100),
      candidate(0, 0, 300, 300),
      candidate(0, 0, 200, 200),
    ]);
    expect(regions.map((r) => r.width)).toEqual([300, 200, 100]);
    expect(selectRegions(snapshot, [candidate(0, 0, 300, 300)])).toEqual(
      selectRegions(snapshot, [candidate(0, 0, 300, 300)]),
    );
  });

  it('clips regions that overhang the viewport', () => {
    const [region] = selectRegions(snapshot, [candidate(900, 700, 400, 400)]);
    expect(region).toBeDefined();
    expect(region?.x).toBe(900);
    expect(region?.width).toBe(100);
    expect(region?.height).toBe(100);
  });

  it('drops regions fully outside the viewport', () => {
    expect(selectRegions(snapshot, [candidate(5000, 5000, 200, 200)])).toEqual([]);
  });

  it('drops regions that become too small after clipping', () => {
    expect(selectRegions(snapshot, [candidate(990, 0, 200, 200)])).toEqual([]);
  });

  it('returns nothing when the viewport has no area', () => {
    const zero = { ...snapshot, viewport: { width: 0, height: 0 } };
    expect(selectRegions(zero, [candidate(0, 0, 200, 200)])).toEqual([]);
  });

  it('handles negative offsets from scrolled-up elements', () => {
    const [region] = selectRegions(snapshot, [candidate(-50, -50, 200, 200)]);
    expect(region?.x).toBe(0);
    expect(region?.y).toBe(0);
    expect(region?.width).toBe(150);
  });
});

describe('analysisScale', () => {
  it('never upscales small regions', () => {
    expect(analysisScale(50, 40)).toBe(1);
  });

  it('downscales so the longest edge fits the analysis budget', () => {
    const scale = analysisScale(1000, 500);
    expect(Math.round(1000 * scale)).toBe(MAX_ANALYSIS_EDGE);
    expect(scale).toBeLessThan(1);
  });

  it('is safe for degenerate input', () => {
    expect(analysisScale(0, 0)).toBe(1);
  });
});
