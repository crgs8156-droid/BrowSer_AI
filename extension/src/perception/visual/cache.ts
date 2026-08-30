// Region result cache for M3 — avoids re-analysing regions that have not changed.
//
// PRIVACY: this cache stores a non-reversible digest plus derived labels. It never
// stores pixels, captures, or text. A digest cannot be turned back into an image.

import type { VisualContentFinding, VisualObservation } from '../../types/contracts';
import type { RasterRegion } from './types';

/** Bounded so a long-lived side panel cannot grow memory without limit. */
export const MAX_CACHE_ENTRIES = 32;

/** Sample at most this many pixels per digest — keeps hashing cost flat. */
const DIGEST_SAMPLE_TARGET = 4096;

/**
 * FNV-1a over a strided sample of the raster, mixed with its dimensions.
 * Cheap, allocation-free, and sensitive enough to notice a region repainting.
 * This is a change detector, not a security primitive.
 */
export function computeRasterDigest(raster: RasterRegion): string {
  const { width, height, data } = raster;
  const pixelCount = width * height;
  if (pixelCount <= 0 || data.length === 0) return `0x0:empty`;

  const stride = Math.max(1, Math.floor(pixelCount / DIGEST_SAMPLE_TARGET)) * 4;

  let hash = 0x811c9dc5;
  for (let p = 0; p < data.length; p += stride) {
    // Mix RGB; alpha is ignored because opaque captures make it constant.
    hash ^= data[p] ?? 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= data[p + 1] ?? 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= data[p + 2] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }

  return `${width}x${height}:${(hash >>> 0).toString(16)}`;
}

interface CacheEntry {
  digest: string;
  observations: VisualObservation[];
  /** Genuine OCR/vision findings for this region, cached alongside observations so a
   *  repeat scan of an unchanged region re-emits them without re-running the engine. */
  contentFindings: VisualContentFinding[];
}

/** What a cache hit yields: the derived observations AND content findings together. */
export interface CachedRegion {
  observations: VisualObservation[];
  contentFindings: VisualContentFinding[];
}

/**
 * Insertion-ordered LRU-ish cache keyed by region id. A region only hits when its
 * geometry AND its pixel digest both match, so a repainted region is reprocessed.
 */
export class VisualRegionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries: number = MAX_CACHE_ENTRIES) {}

  get(regionId: string, digest: string): CachedRegion | null {
    const entry = this.entries.get(regionId);
    if (entry === undefined || entry.digest !== digest) return null;

    // Refresh recency.
    this.entries.delete(regionId);
    this.entries.set(regionId, entry);
    return { observations: entry.observations, contentFindings: entry.contentFindings };
  }

  set(
    regionId: string,
    digest: string,
    observations: VisualObservation[],
    contentFindings: VisualContentFinding[] = [],
  ): void {
    if (this.entries.has(regionId)) this.entries.delete(regionId);
    this.entries.set(regionId, { digest, observations, contentFindings });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
