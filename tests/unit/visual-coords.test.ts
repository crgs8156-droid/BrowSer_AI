// Unit tests for raster→region coordinate mapping (Priority 2 — item "bbox coordinate
// conversion"). The OCR/vision engine reports boxes in downscaled raster pixels; the
// service must map them back to the region's CSS-px space so masks land where the value
// was painted. PURE function — no capture, no engine.

import { describe, expect, it } from 'vitest';
import { mapRasterBboxToRegion } from '../../extension/src/perception/visual/coords';
import type { VisualRegion } from '../../extension/src/types/contracts';

const region: VisualRegion = { id: 'r-100-200-400x300', x: 100, y: 200, width: 400, height: 300 };

describe('mapRasterBboxToRegion', () => {
  it('maps a full-raster box to the whole region', () => {
    // Raster is a downscaled crop of the region (here 200x150 for a 400x300 region).
    const out = mapRasterBboxToRegion([0, 0, 200, 150], region, { width: 200, height: 150 });
    expect(out).toEqual([100, 200, 400, 300]);
  });

  it('upscales a sub-box and offsets it by the region origin', () => {
    // A box at raster (100,75) size 50x30 in a 200x150 raster → 2x scale, +origin.
    const out = mapRasterBboxToRegion([100, 75, 50, 30], region, { width: 200, height: 150 });
    expect(out).toEqual([300, 350, 100, 60]);
  });

  it('clamps a box that overflows the raster to the analyzed pixels', () => {
    const out = mapRasterBboxToRegion([180, 140, 100, 100], region, { width: 200, height: 150 });
    // Clamped to raster (200x150): x 180→ maps to 100+180*2=460, width (200-180)*2=40.
    expect(out).toEqual([460, 480, 40, 20]);
  });

  it('never produces negative geometry from a garbage box', () => {
    const out = mapRasterBboxToRegion([-50, -50, -10, -10], region, { width: 200, height: 150 });
    expect(out[2]).toBeGreaterThanOrEqual(0);
    expect(out[3]).toBeGreaterThanOrEqual(0);
    expect(out[0]).toBeGreaterThanOrEqual(region.x);
    expect(out[1]).toBeGreaterThanOrEqual(region.y);
  });

  it('degrades safely on a zero-size raster', () => {
    const out = mapRasterBboxToRegion([0, 0, 10, 10], region, { width: 0, height: 0 });
    expect(out.every((n) => Number.isFinite(n))).toBe(true);
  });
});
