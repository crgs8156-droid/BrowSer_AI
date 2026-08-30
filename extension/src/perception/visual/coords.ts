// Coordinate mapping for the OCR/vision content layer (PURE; no I/O, no logging).
//
// An OCR/vision engine sees the DOWNSCALED raster crop of a region and reports
// bounding boxes in RASTER pixel coordinates. Everything downstream (M4 policy, M5
// masking, the summary's page-section math) works in the region's own coordinate
// space — document-absolute CSS px for below-fold regions, viewport-relative CSS px
// for visible ones. This module maps a raster-pixel bbox back into that space so a
// recognized sub-region lands exactly where it was painted.
//
// The mapping is the inverse of the rasterizer's crop+downscale: the raster spans the
// whole region, so raster→region scale is (region size ÷ raster size); the result is
// then offset by the region's origin. Boxes are clamped to the region bounds — a
// finding can never be reported outside the pixels that were actually analyzed.

import type { VisualRegion } from '../../types/contracts';

type Bbox = [number, number, number, number];

/**
 * Map a raster-pixel `raw` bbox to the region's coordinate space (CSS px).
 *
 * @param raw    [x, y, width, height] in raster pixels of the analyzed crop
 * @param region the analyzed region, carrying its origin + CSS size
 * @param raster the raster dimensions the engine actually saw
 * @returns [x, y, width, height] in the region's CSS-px space, clamped to the region
 */
export function mapRasterBboxToRegion(
  raw: Bbox,
  region: VisualRegion,
  raster: { width: number; height: number },
): Bbox {
  const rw = raster.width > 0 ? raster.width : 1;
  const rh = raster.height > 0 ? raster.height : 1;
  const scaleX = region.width / rw;
  const scaleY = region.height / rh;

  // Clamp the raw box to the raster first, so a misbehaving engine cannot push a
  // finding outside the analyzed pixels.
  const rx0 = clamp(raw[0], 0, rw);
  const ry0 = clamp(raw[1], 0, rh);
  const rx1 = clamp(raw[0] + raw[2], 0, rw);
  const ry1 = clamp(raw[1] + raw[3], 0, rh);

  const x = region.x + rx0 * scaleX;
  const y = region.y + ry0 * scaleY;
  const width = Math.max(0, (rx1 - rx0) * scaleX);
  const height = Math.max(0, (ry1 - ry0) * scaleY);

  return [round(x), round(y), round(width), round(height)];
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
