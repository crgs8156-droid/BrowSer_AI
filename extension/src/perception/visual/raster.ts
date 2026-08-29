// Browser rasterizer for M3: crops ONE bounded region out of a viewport capture and
// downscales it for analysis.
//
// PRIVACY: everything in this file operates on local pixel buffers. The capture and
// every derived raster stay in this process; they are never logged, persisted, or
// transmitted. The ImageBitmap is explicitly closed so the decoded frame does not
// linger in memory.
//
// Cropping happens here rather than at capture time because Chrome's
// `captureVisibleTab` only returns whole visible tabs — there is no partial-capture
// API. We therefore discard everything outside the selected region immediately and
// never hand the full capture to a provider.

import { analysisScale } from './regions';
import type { RasterizeFn, RasterRegion } from './types';

type Canvas2d = {
  drawImage: OffscreenCanvasRenderingContext2D['drawImage'];
  getImageData: OffscreenCanvasRenderingContext2D['getImageData'];
};

function createCanvasContext(width: number, height: number): Canvas2d | null {
  if (typeof OffscreenCanvas === 'function') {
    const context = new OffscreenCanvas(width, height).getContext('2d', {
      willReadFrequently: true,
    });
    return context ?? null;
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return context ?? null;
  }

  return null;
}

/**
 * Build a rasterizer bound to the current document context.
 * Returns null (never throws) whenever decoding is impossible, so the service can
 * degrade to `unavailable` instead of failing the run.
 */
export function createBrowserRasterizer(): RasterizeFn {
  return async (captureDataUrl, region, options) => {
    if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') return null;

    let bitmap: ImageBitmap | null = null;
    try {
      const response = await fetch(captureDataUrl);
      const blob = await response.blob();
      bitmap = await createImageBitmap(blob);

      // Captures are in device pixels; region coordinates are in CSS pixels.
      const sourceScale =
        options.viewportWidth > 0 ? bitmap.width / options.viewportWidth : 1;

      const sx = Math.max(0, Math.floor(region.x * sourceScale));
      const sy = Math.max(0, Math.floor(region.y * sourceScale));
      const sw = Math.min(bitmap.width - sx, Math.ceil(region.width * sourceScale));
      const sh = Math.min(bitmap.height - sy, Math.ceil(region.height * sourceScale));
      if (sw <= 1 || sh <= 1) return null;

      const scale = analysisScale(sw, sh, options.maxEdge);
      const dw = Math.max(1, Math.round(sw * scale));
      const dh = Math.max(1, Math.round(sh * scale));

      const context = createCanvasContext(dw, dh);
      if (context === null) return null;

      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
      const imageData = context.getImageData(0, 0, dw, dh);

      const raster: RasterRegion = {
        width: imageData.width,
        height: imageData.height,
        data: imageData.data,
      };
      return raster;
    } catch {
      // Decode/draw failure (tainted canvas, malformed data URL, OOM) — degrade quietly.
      // Deliberately not logged: the error payload can echo capture bytes.
      return null;
    } finally {
      bitmap?.close();
    }
  };
}
