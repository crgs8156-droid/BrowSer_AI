// M3 — end-to-end pipeline behaviour with injected capture/raster fakes.
//
// No real browser APIs are used: the service is driven through its injection points
// so the ordering guarantees (restricted → DOM-first → capability → bounded regions →
// capture → cache → lazy provider) can be asserted deterministically.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createVisualPerceptionService } from '../../extension/src/perception/visual/service';
import type { VisualPerceptionDeps } from '../../extension/src/perception/visual/service';
import { MAX_ANALYSIS_EDGE } from '../../extension/src/perception/visual/regions';
import {
  isVisualProviderLoaded,
  registerVisualProvider,
  resetVisualProviders,
} from '../../extension/src/perception/visual/providers/registry';
import { createPixelStatsProvider } from '../../extension/src/perception/visual/providers/pixel-stats';
import type { RasterizeFn, VisualCapabilities, VisualProvider } from '../../extension/src/perception/visual/types';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';
import { textLikeRaster } from '../helpers/raster';

const CAPABLE: VisualCapabilities = { backends: ['cpu'], canRasterize: true, hasDocument: true };

/** A data URL standing in for a viewport capture, carrying a synthetic canary. */
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

describe('pipeline exits before doing any work', () => {
  it('reports a restricted page without capturing anything', async () => {
    const result = await service().run(snapshot({ url: 'chrome://settings' }));

    expect(result).toMatchObject({
      status: 'restricted_page',
      supported: false,
      reason: 'browser_security_restriction',
      observations: [],
    });
    expect(capture).not.toHaveBeenCalled();
    expect(isVisualProviderLoaded()).toBe(false);
  });

  it('skips capture and provider load when the DOM is sufficient', async () => {
    const result = await service().run(
      snapshot({ candidates: [candidate({ hasAccessibleText: true })] }),
    );

    expect(result.status).toBe('not_required');
    expect(result.supported).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(rasterize).not.toHaveBeenCalled();
    expect(isVisualProviderLoaded()).toBe(false);
  });

  it('does not load a provider merely because a page was opened', async () => {
    const instance = service();
    await instance.run(snapshot({ candidates: [] }));
    await instance.run(snapshot({ candidates: [candidate({ domTextLength: 80 })] }));
    expect(isVisualProviderLoaded()).toBe(false);
  });

  it('degrades when the context cannot rasterize', async () => {
    const result = await service({
      capabilities: { backends: ['cpu'], canRasterize: false, hasDocument: false },
    }).run(snapshot());

    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('rasterization_unsupported_in_context');
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects a malformed snapshot instead of attempting a capture', async () => {
    const result = await service().run(null as unknown as DomVisualSnapshot);
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('invalid_snapshot');
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('pipeline completes', () => {
  it('produces observations for a visual-only region', async () => {
    const result = await service().run(snapshot());

    expect(result.status).toBe('completed');
    expect(result.supported).toBe(true);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      type: 'visual_observation',
      local: true,
      source: 'vision',
    });
    expect(result.metrics.regionsProcessed).toBe(1);
    expect(result.metrics.regionsFromCache).toBe(0);
    expect(result.metrics.candidatesConsidered).toBe(1);
  });

  it('captures once per run regardless of region count', async () => {
    await service().run(
      snapshot({
        candidates: [
          candidate({ rect: { x: 0, y: 0, width: 300, height: 200 } }),
          candidate({ rect: { x: 400, y: 0, width: 300, height: 200 } }),
          candidate({ rect: { x: 0, y: 300, width: 300, height: 200 } }),
        ],
      }),
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(rasterize).toHaveBeenCalledTimes(3);
  });

  it('bounds analysis resolution and passes the viewport width for DPR mapping', async () => {
    await service().run(snapshot());

    expect(rasterize).toHaveBeenCalledWith(
      CAPTURE,
      expect.objectContaining({ width: 300, height: 200 }),
      { viewportWidth: 1280, maxEdge: MAX_ANALYSIS_EDGE },
    );
  });

  it('records a real measured duration', async () => {
    let clock = 1000;
    const result = await service({
      now: () => {
        clock += 5;
        return clock;
      },
    }).run(snapshot());

    expect(result.metrics.durationMs).toBeGreaterThan(0);
  });
});

describe('pipeline avoids repeat work', () => {
  it('serves an unchanged region from cache on the next run', async () => {
    const instance = service();

    const first = await instance.run(snapshot());
    const second = await instance.run(snapshot());

    expect(first.metrics.regionsProcessed).toBe(1);
    expect(second.metrics.regionsProcessed).toBe(0);
    expect(second.metrics.regionsFromCache).toBe(1);
    expect(second.observations).toEqual(first.observations);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('reprocesses a region once its pixels change', async () => {
    const instance = service();
    await instance.run(snapshot());

    rasterize.mockResolvedValueOnce({
      width: 120,
      height: 48,
      data: new Uint8ClampedArray(120 * 48 * 4).fill(200),
    });
    const second = await instance.run(snapshot());

    expect(second.metrics.regionsProcessed).toBe(1);
    expect(second.metrics.regionsFromCache).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('clears cached results on dispose', async () => {
    const instance = service();
    await instance.run(snapshot());
    await instance.dispose();

    const afterDispose = await instance.run(snapshot());
    expect(afterDispose.metrics.regionsFromCache).toBe(0);
    expect(afterDispose.metrics.regionsProcessed).toBe(1);
  });

  it('refuses to stack overlapping runs', async () => {
    let release: (value: string) => void = () => {};
    capture.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const instance = service();
    const first = instance.run(snapshot());
    const second = await instance.run(snapshot());

    expect(second.status).toBe('running');
    expect(second.reason).toBe('run_in_progress');

    release(CAPTURE);
    expect((await first).status).toBe('completed');
  });
});

describe('pipeline fails soft', () => {
  it('reports capture refusal without throwing', async () => {
    capture.mockRejectedValueOnce(new Error('Cannot access contents of the page'));

    const result = await service().run(snapshot());
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('VISUAL_CAPTURE_UNAVAILABLE');
    expect(result.observations).toEqual([]);
  });

  it('surfaces the sanitized capture-failure diagnostic in reasonDetail', async () => {
    capture.mockRejectedValueOnce(new Error('Cannot access contents of the page'));

    const result = await service().run(snapshot());
    // The real API cause is visible (so a persistent "unavailable" is debuggable)…
    expect(result.reasonDetail).toBe('Cannot access contents of the page');
  });

  it('never lets pixel bytes ride out through reasonDetail', async () => {
    // A hostile/odd error carrying a data URL must be reduced to a safe token, not echoed.
    capture.mockRejectedValueOnce(new Error('data:image/png;base64,SECRETPIXELS'));

    const result = await service().run(snapshot());
    expect(result.reasonDetail).toBe('capture_error');
    expect(JSON.stringify(result)).not.toContain('SECRETPIXELS');
  });

  it('skips regions that cannot be decoded', async () => {
    rasterize.mockResolvedValue(null);

    const result = await service().run(snapshot());
    expect(result.status).toBe('completed');
    expect(result.observations).toEqual([]);
    expect(result.metrics.regionsProcessed).toBe(0);
    expect(isVisualProviderLoaded()).toBe(false);
  });

  it('never leaks a rejection to the caller', async () => {
    capture.mockRejectedValue(new Error('boom'));
    await expect(service().run(snapshot())).resolves.toMatchObject({ status: 'unavailable' });
  });
});
