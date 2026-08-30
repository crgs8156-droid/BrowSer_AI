// M3 — below-the-fold band capture through the real service, with injected fakes.
//
// Proves the OPTIONAL `scrollViewport` dependency turns on bounded band capture without
// changing the no-scroll path, and that:
//   - below-fold candidates surface as distinct observations (multi-region preserved);
//   - the service scrolls to each planned band, captures there, and RESTORES the original
//     scroll afterwards;
//   - a failed band degrades closed (that band is skipped, never faked);
//   - absent `scrollViewport`, below-fold candidates are simply not covered (honest limit).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createVisualPerceptionService } from '../../extension/src/perception/visual/service';
import type { VisualPerceptionDeps } from '../../extension/src/perception/visual/service';
import {
  registerVisualProvider,
  resetVisualProviders,
} from '../../extension/src/perception/visual/providers/registry';
import { createPixelStatsProvider } from '../../extension/src/perception/visual/providers/pixel-stats';
import type { RasterizeFn, VisualCapabilities, VisualProvider } from '../../extension/src/perception/visual/types';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';
import { textLikeRaster } from '../helpers/raster';

const CAPABLE: VisualCapabilities = { backends: ['cpu'], canRasterize: true, hasDocument: true };
const CAPTURE = 'data:image/png;base64,Q0FOQVJZX0NBUFRVUkVfMDAx';

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
    candidates: [candidate()],
    scrollY: 0,
    ...overrides,
  };
}

let capture: Mock<() => Promise<string>>;
let rasterize: Mock<RasterizeFn>;
let analyze: Mock<VisualProvider['analyze']>;

beforeEach(async () => {
  await resetVisualProviders();
  capture = vi.fn<() => Promise<string>>(() => Promise.resolve(CAPTURE));
  rasterize = vi.fn<RasterizeFn>(() => Promise.resolve(textLikeRaster()));
  const real = createPixelStatsProvider();
  analyze = vi.fn<VisualProvider['analyze']>((raster, region, backend) =>
    real.analyze(raster, region, backend),
  );
  registerVisualProvider(() => ({ name: 'test-pixel-stats', source: 'vision', analyze }));
});

function service(overrides: Partial<VisualPerceptionDeps> = {}) {
  return createVisualPerceptionService({
    captureViewport: capture,
    rasterize,
    capabilities: CAPABLE,
    ...overrides,
  });
}

describe('below-the-fold band capture', () => {
  it('does NOT cover below-fold candidates when no scroller is injected (honest limit)', async () => {
    const belowFold = candidate({ rect: { x: 0, y: 1000, width: 300, height: 200 } });
    const result = await service().run(snapshot({ candidates: [belowFold] }));

    // The only candidate is below the fold and there is no scroller → nothing to inspect.
    expect(result.status).toBe('not_required');
    expect(result.reason).toBe('no_regions_after_bounding');
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures a below-fold band when a scroller is injected, restoring scroll after', async () => {
    const scrolls: number[] = [];
    const scrollViewport = vi.fn<(top: number) => Promise<void>>((top) => {
      scrolls.push(top);
      return Promise.resolve();
    });
    const belowFold = candidate({ rect: { x: 0, y: 1000, width: 300, height: 200 } });

    const result = await service({ scrollViewport }).run(
      snapshot({ candidates: [belowFold], scrollY: 0 }),
    );

    expect(result.status).toBe('completed');
    expect(result.observations).toHaveLength(1);
    // docTop 1000 → band 800; original scroll (0) restored last.
    expect(scrolls[0]).toBe(800);
    expect(scrolls[scrolls.length - 1]).toBe(0);
    expect(capture).toHaveBeenCalled();
  });

  it('preserves multiple independent below-fold regions as distinct observations', async () => {
    const scrollViewport = vi.fn<(top: number) => Promise<void>>(() => Promise.resolve());
    const cands = [
      candidate({ rect: { x: 0, y: 900, width: 300, height: 120 } }),
      candidate({ rect: { x: 500, y: 1000, width: 300, height: 120 } }),
      candidate({ rect: { x: 0, y: 1700, width: 300, height: 120 } }),
    ];
    const result = await service({ scrollViewport }).run(snapshot({ candidates: cands }));

    expect(result.status).toBe('completed');
    expect(result.observations).toHaveLength(3);
    const ys = result.observations.map((observation) => observation.region.y).sort((a, b) => a - b);
    expect(ys).toEqual([900, 1000, 1700]);
  });

  it('degrades closed when a band capture fails, without faking coverage', async () => {
    const scrollViewport = vi.fn<(top: number) => Promise<void>>(() => Promise.resolve());
    // First capture (the band) rejects; there is no viewport region, so nothing is faked.
    capture.mockRejectedValueOnce(new Error('capture refused'));
    const belowFold = candidate({ rect: { x: 0, y: 1000, width: 300, height: 200 } });

    const result = await service({ scrollViewport }).run(snapshot({ candidates: [belowFold] }));

    expect(result.status).toBe('completed');
    expect(result.observations).toEqual([]);
  });

  it('covers the visible viewport AND a below-fold band together', async () => {
    const scrollViewport = vi.fn<(top: number) => Promise<void>>(() => Promise.resolve());
    const cands = [
      candidate({ rect: { x: 0, y: 100, width: 300, height: 200 } }), // visible
      candidate({ rect: { x: 0, y: 1000, width: 300, height: 200 } }), // below fold
    ];
    const result = await service({ scrollViewport }).run(snapshot({ candidates: cands }));

    expect(result.status).toBe('completed');
    expect(result.observations).toHaveLength(2);
    // One capture for the visible viewport + one for the band.
    expect(capture).toHaveBeenCalledTimes(2);
  });
});
