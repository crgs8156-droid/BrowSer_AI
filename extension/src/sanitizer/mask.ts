// M5 — visual-region enforcement primitives.
//
// Two pure functions with no I/O and no logging:
//   - `mergeMaskRegions` turns per-finding boxes into deterministic mask
//     directives, merging overlapping boxes into their union so the protected
//     area is never smaller than the sensitive regions (overlap fail-safe).
//   - `applyMasks` obscures those regions in a LOCAL pixel buffer.
//
// PRIVACY: these operate on geometry and local pixels only. A directive carries
// coordinates and finding ids — never pixels; `applyMasks` returns a NEW buffer
// and never logs or transmits. Raw visual data is local-only (M3 invariant) and
// no image field exists on `RemoteAgentRequest`, so masking is a local
// defence-in-depth measure, not an outbound scrub.

import type { PerceptionSource, VisualMaskDirective } from '../types/contracts';

type Bbox = [number, number, number, number];

/** A local RGBA pixel buffer. Structurally compatible with M3's `RasterRegion`. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface MaskInput {
  bbox: Bbox;
  findingId: string;
  source: PerceptionSource;
}

function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

function union(a: Bbox, b: Bbox): Bbox {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const right = Math.max(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x, y, right - x, bottom - y];
}

function pickSource(sources: Set<PerceptionSource>): PerceptionSource {
  if (sources.size === 1) return sources.values().next().value ?? 'FUSED';
  // Mixed origins for one merged region → report it as fused.
  return 'FUSED';
}

/**
 * Cluster mask inputs so any two overlapping boxes end up in one directive whose
 * bbox is their union. Merging repeats to a fixpoint (a union can newly overlap a
 * third box). Disjoint regions stay separate — the whole page is never masked
 * just because two far-apart regions are sensitive. Output is sorted top-to-bottom
 * then left-to-right for determinism, and every input finding id is preserved.
 */
export function mergeMaskRegions(inputs: readonly MaskInput[]): VisualMaskDirective[] {
  const clusters: { bbox: Bbox; ids: Set<string>; sources: Set<PerceptionSource> }[] = inputs.map(
    (input) => ({ bbox: input.bbox, ids: new Set([input.findingId]), sources: new Set([input.source]) }),
  );

  const mergeOnce = (): boolean => {
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i]!;
        const cj = clusters[j]!;
        if (intersects(ci.bbox, cj.bbox)) {
          ci.bbox = union(ci.bbox, cj.bbox);
          for (const id of cj.ids) ci.ids.add(id);
          for (const s of cj.sources) ci.sources.add(s);
          clusters.splice(j, 1);
          return true;
        }
      }
    }
    return false;
  };
  while (mergeOnce()) {
    // keep merging until no two clusters overlap
  }

  return clusters
    .map((c) => ({ bbox: c.bbox, findingIds: Array.from(c.ids).sort(), source: pickSource(c.sources) }))
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/**
 * Return a COPY of `buffer` with every region filled opaque black. Regions are
 * clipped to the buffer bounds; the input is never mutated. Pure — no I/O.
 */
export function applyMasks(buffer: PixelBuffer, regions: readonly Bbox[]): PixelBuffer {
  const { width, height } = buffer;
  const data = new Uint8ClampedArray(buffer.data);
  for (const [rx, ry, rw, rh] of regions) {
    const x0 = Math.max(0, Math.floor(rx));
    const y0 = Math.max(0, Math.floor(ry));
    const x1 = Math.min(width, Math.ceil(rx + rw));
    const y1 = Math.min(height, Math.ceil(ry + rh));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * width + x) * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = 255;
      }
    }
  }
  return { width, height, data };
}
