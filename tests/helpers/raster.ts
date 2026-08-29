// Synthetic raster fixtures for M3 tests.
// All values are generated locally; no real page pixels are used anywhere in tests.

import type { RasterRegion } from '../../extension/src/perception/visual/types';

export function makeRaster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
): RasterRegion {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      const p = (y * width + x) * 4;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Uniform fill — no structure, no edges. */
export function flatRaster(width = 64, height = 64, value = 128): RasterRegion {
  return makeRaster(width, height, () => value);
}

/**
 * Synthetic rendered text: bands of "glyph" rows (frequent horizontal transitions)
 * separated by blank line-gap rows.
 */
export function textLikeRaster(width = 120, height = 48): RasterRegion {
  return makeRaster(width, height, (x, y) => {
    const isGlyphRow = y % 8 < 4;
    if (!isGlyphRow) return 255;
    return x % 6 < 3 ? 10 : 245;
  });
}

/** Smooth horizontal gradient: high variance, but almost no local edges. */
export function gradientRaster(width = 120, height = 48): RasterRegion {
  return makeRaster(width, height, (x) => Math.round((x / Math.max(1, width - 1)) * 255));
}
