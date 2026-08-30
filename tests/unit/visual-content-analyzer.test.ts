// Unit tests for the OCR/vision content-analyzer registry (Priority 2 — items
// "OCR unavailable", "no fabricated detections", laziness). Proves the HONEST default
// (explicit not_available, zero findings, nothing constructed) and the registration path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isVisualContentAnalyzerAvailable,
  isVisualContentAnalyzerLoaded,
  registerVisualContentAnalyzer,
  resetVisualContentAnalyzer,
  resolveVisualContentAnalyzer,
} from '../../extension/src/perception/visual/content-analyzer';
import type { RasterRegion } from '../../extension/src/perception/visual/types';
import type { VisualRegion } from '../../extension/src/types/contracts';

const raster: RasterRegion = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
const region: VisualRegion = { id: 'r-0-0-4x4', x: 0, y: 0, width: 4, height: 4 };

afterEach(async () => {
  await resetVisualContentAnalyzer();
});

describe('visual content-analyzer registry', () => {
  it('defaults to an explicit not_available analyzer that fabricates nothing', async () => {
    expect(isVisualContentAnalyzerAvailable()).toBe(false);
    const analyzer = await resolveVisualContentAnalyzer();
    const result = await analyzer.analyze(raster, region, 'cpu');
    expect(result.status).toBe('not_available');
    expect(result.findings).toEqual([]);
    // The default is a constant — no engine was constructed.
    expect(isVisualContentAnalyzerLoaded()).toBe(false);
  });

  it('does not construct a registered engine until first resolve (laziness)', async () => {
    const factory = vi.fn(() => ({
      name: 'fake-ocr',
      analyze: () => Promise.resolve({ status: 'ok' as const, findings: [] }),
    }));
    registerVisualContentAnalyzer(factory);
    expect(isVisualContentAnalyzerAvailable()).toBe(true);
    expect(factory).not.toHaveBeenCalled();

    const analyzer = await resolveVisualContentAnalyzer();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(analyzer.name).toBe('fake-ocr');
    expect(isVisualContentAnalyzerLoaded()).toBe(true);
  });

  it('shares a single in-flight construction across concurrent callers', async () => {
    const factory = vi.fn(
      () =>
        new Promise<{ name: string; analyze: () => Promise<{ status: 'ok'; findings: [] }> }>(
          (resolve) =>
            setTimeout(
              () => resolve({ name: 'slow', analyze: () => Promise.resolve({ status: 'ok', findings: [] }) }),
              5,
            ),
        ),
    );
    registerVisualContentAnalyzer(factory);
    const [a, b] = await Promise.all([resolveVisualContentAnalyzer(), resolveVisualContentAnalyzer()]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('reset returns to the honest not_available default', async () => {
    registerVisualContentAnalyzer(() => ({
      name: 'fake',
      analyze: () => Promise.resolve({ status: 'ok', findings: [] }),
    }));
    await resolveVisualContentAnalyzer();
    await resetVisualContentAnalyzer();
    expect(isVisualContentAnalyzerAvailable()).toBe(false);
    const analyzer = await resolveVisualContentAnalyzer();
    expect((await analyzer.analyze(raster, region, 'cpu')).status).toBe('not_available');
  });
});
