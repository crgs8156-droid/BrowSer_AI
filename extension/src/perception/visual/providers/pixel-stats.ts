// Default M3 provider: real pixel statistics, zero dependencies, zero model download.
//
// WHAT THIS DOES: measures contrast, edge density and row-brightness periodicity on
// actual pixels, then reports a coarse structural label.
//
// WHAT THIS DOES NOT DO: it does not read text. It cannot tell you what a region
// says, and it never guesses. `text_like_content` means "this region has the
// contrast and horizontal-line structure typical of rendered text" — nothing more.
// Transcription requires a registered OCR recognizer (see ../../ocr/index.ts).
//
// Confidence is capped at MAX_CONFIDENCE because these are heuristics on
// downscaled rasters. Reporting higher would misrepresent the method.

import type { VisualObservation, VisualObservationLabel, VisualRegion } from '../../../types/contracts';
import type { RasterRegion, VisualProvider } from '../types';

/** Honest ceiling for a heuristic signal. Do not raise without a benchmark. */
export const MAX_CONFIDENCE = 0.75;
const MIN_CONFIDENCE = 0.35;

/** Luminance step between neighbours that counts as an edge (0–255 scale). */
const EDGE_DELTA = 24;
/** Edge density at or above which a region looks like rendered glyphs. */
const TEXT_EDGE_DENSITY = 0.08;
/** Text needs several bright/dark row alternations (line spacing). */
const MIN_ROW_TRANSITIONS = 3;
/** Luminance variance floor for "there is structure here at all". */
const TEXT_MIN_VARIANCE = 200;
/** Below these a region is flat colour / whitespace. */
const LOW_INFO_VARIANCE = 60;
const LOW_INFO_EDGE_DENSITY = 0.02;

interface RasterStatistics {
  variance: number;
  edgeDensity: number;
  rowTransitions: number;
}

function clampConfidence(value: number): number {
  const bounded = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, value));
  return Math.round(bounded * 100) / 100;
}

/** ITU-R BT.709 luminance per pixel. */
function toLuminance(raster: RasterRegion): Float32Array {
  const data = raster.data;
  const out = new Float32Array(raster.width * raster.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] =
      0.2126 * (data[p] ?? 0) + 0.7152 * (data[p + 1] ?? 0) + 0.0722 * (data[p + 2] ?? 0);
  }
  return out;
}

export function computeRasterStatistics(raster: RasterRegion): RasterStatistics | null {
  const { width, height } = raster;
  if (width <= 1 || height <= 1) return null;
  if (raster.data.length < width * height * 4) return null;

  const luminance = toLuminance(raster);

  let sum = 0;
  for (let i = 0; i < luminance.length; i++) sum += luminance[i] ?? 0;
  const mean = sum / luminance.length;

  let squaredError = 0;
  for (let i = 0; i < luminance.length; i++) {
    const delta = (luminance[i] ?? 0) - mean;
    squaredError += delta * delta;
  }
  const variance = squaredError / luminance.length;

  // Horizontal edges: glyph strokes produce many short transitions per row.
  let edges = 0;
  const rowMeans = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const value = luminance[rowStart + x] ?? 0;
      rowSum += value;
      if (x > 0 && Math.abs(value - (luminance[rowStart + x - 1] ?? 0)) > EDGE_DELTA) edges++;
    }
    rowMeans[y] = rowSum / width;
  }
  const edgeDensity = edges / ((width - 1) * height);

  // Text lines alternate ink rows and gap rows, so row means cross the page mean
  // repeatedly. A photo or gradient crosses far less often.
  let rowTransitions = 0;
  for (let y = 1; y < height; y++) {
    const previous = (rowMeans[y - 1] ?? 0) - mean;
    const current = (rowMeans[y] ?? 0) - mean;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) rowTransitions++;
  }

  return { variance, edgeDensity, rowTransitions };
}

function classify(
  stats: RasterStatistics,
): { label: VisualObservationLabel; confidence: number } {
  const { variance, edgeDensity, rowTransitions } = stats;

  if (variance < LOW_INFO_VARIANCE && edgeDensity < LOW_INFO_EDGE_DENSITY) {
    const flatness = 1 - Math.min(1, variance / LOW_INFO_VARIANCE);
    return { label: 'low_information', confidence: clampConfidence(0.4 + 0.35 * flatness) };
  }

  if (
    edgeDensity >= TEXT_EDGE_DENSITY &&
    rowTransitions >= MIN_ROW_TRANSITIONS &&
    variance >= TEXT_MIN_VARIANCE
  ) {
    const edgeStrength = Math.min(1, edgeDensity / 0.25);
    const lineStrength = Math.min(1, rowTransitions / 12);
    return {
      label: 'text_like_content',
      confidence: clampConfidence(MIN_CONFIDENCE + 0.4 * (0.5 * edgeStrength + 0.5 * lineStrength)),
    };
  }

  return {
    label: 'graphic_content',
    confidence: clampConfidence(MIN_CONFIDENCE + 0.15 * Math.min(1, variance / 2000)),
  };
}

/**
 * Build the default provider. Constructing it is cheap and allocates nothing —
 * there is no model to load, so `dispose()` has nothing to release.
 */
export function createPixelStatsProvider(): VisualProvider {
  return {
    name: 'pixel-stats',
    // 'vision' — this provider observes structure. It is NOT an OCR source.
    source: 'vision',

    analyze(raster: RasterRegion, region: VisualRegion): Promise<VisualObservation[]> {
      const stats = computeRasterStatistics(raster);
      // Malformed/degenerate raster ⇒ report nothing rather than inventing a label.
      if (stats === null) return Promise.resolve([]);

      const { label, confidence } = classify(stats);
      const observation: VisualObservation = {
        type: 'visual_observation',
        source: 'vision',
        region,
        observations: [label],
        confidence,
        local: true,
      };
      return Promise.resolve([observation]);
    },
  };
}
