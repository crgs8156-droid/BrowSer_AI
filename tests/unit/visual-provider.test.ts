// M3 — default provider behaviour, provider registry laziness, and region caching.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CONFIDENCE,
  computeRasterStatistics,
  createPixelStatsProvider,
} from '../../extension/src/perception/visual/providers/pixel-stats';
import {
  isVisualProviderLoaded,
  registerVisualProvider,
  resetVisualProviders,
  resolveVisualProvider,
} from '../../extension/src/perception/visual/providers/registry';
import {
  MAX_CACHE_ENTRIES,
  VisualRegionCache,
  computeRasterDigest,
} from '../../extension/src/perception/visual/cache';
import type { RasterRegion, VisualProvider } from '../../extension/src/perception/visual/types';
import type { VisualObservation, VisualRegion } from '../../extension/src/types/contracts';
import { flatRaster, gradientRaster, makeRaster, textLikeRaster } from '../helpers/raster';

const region: VisualRegion = { id: 'r-0-0-120x48', x: 0, y: 0, width: 120, height: 48 };

afterEach(async () => {
  await resetVisualProviders();
});

describe('pixel-stats provider', () => {
  it('labels synthetic rendered text as text-like', async () => {
    const [observation] = await createPixelStatsProvider().analyze(textLikeRaster(), region, 'cpu');
    expect(observation?.observations).toEqual(['text_like_content']);
  });

  it('labels a flat fill as low information', async () => {
    const [observation] = await createPixelStatsProvider().analyze(flatRaster(), region, 'cpu');
    expect(observation?.observations).toEqual(['low_information']);
  });

  it('labels a smooth gradient as graphic content, not text', async () => {
    const [observation] = await createPixelStatsProvider().analyze(gradientRaster(), region, 'cpu');
    expect(observation?.observations).toEqual(['graphic_content']);
  });

  it('emits the documented observation shape', async () => {
    const [observation] = await createPixelStatsProvider().analyze(textLikeRaster(), region, 'cpu');
    expect(observation).toMatchObject({
      type: 'visual_observation',
      source: 'vision',
      local: true,
      region,
    });
    expect(Array.isArray(observation?.observations)).toBe(true);
  });

  it('never claims more confidence than a heuristic can support', async () => {
    const provider = createPixelStatsProvider();
    for (const raster of [textLikeRaster(), flatRaster(), gradientRaster()]) {
      const [observation] = await provider.analyze(raster, region, 'cpu');
      expect(observation?.confidence).toBeLessThanOrEqual(MAX_CONFIDENCE);
      expect(observation?.confidence).toBeGreaterThan(0);
    }
  });

  it('reports nothing at all for a degenerate raster instead of guessing', async () => {
    const provider = createPixelStatsProvider();
    const empty: RasterRegion = { width: 0, height: 0, data: new Uint8ClampedArray(0) };
    expect(await provider.analyze(empty, region, 'cpu')).toEqual([]);

    const truncated: RasterRegion = { width: 10, height: 10, data: new Uint8ClampedArray(8) };
    expect(await provider.analyze(truncated, region, 'cpu')).toEqual([]);
    expect(computeRasterStatistics(truncated)).toBeNull();
  });

  it('is deterministic for identical pixels', async () => {
    const provider = createPixelStatsProvider();
    const first = await provider.analyze(textLikeRaster(), region, 'cpu');
    const second = await provider.analyze(textLikeRaster(), region, 'cpu');
    expect(first).toEqual(second);
  });

  it('does not transcribe: no observation carries recognised text', async () => {
    const [observation] = await createPixelStatsProvider().analyze(textLikeRaster(), region, 'cpu');
    expect(JSON.stringify(observation)).not.toMatch(/text":\s*"/);
    expect(observation).not.toHaveProperty('text');
  });
});

describe('provider registry', () => {
  it('does not construct a provider until one is resolved', async () => {
    await resetVisualProviders();
    expect(isVisualProviderLoaded()).toBe(false);
  });

  it('constructs the default provider lazily, exactly once', async () => {
    const first = await resolveVisualProvider();
    const second = await resolveVisualProvider();
    expect(first).toBe(second);
    expect(isVisualProviderLoaded()).toBe(true);
    expect(first.name).toBe('pixel-stats');
  });

  it('shares a single in-flight load between concurrent callers', async () => {
    const factory = vi.fn(() => createPixelStatsProvider());
    registerVisualProvider(factory);
    await Promise.all([resolveVisualProvider(), resolveVisualProvider(), resolveVisualProvider()]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('lets a custom provider replace the default without touching call sites', async () => {
    const custom: VisualProvider = {
      name: 'stub-recognizer',
      source: 'ocr',
      analyze: () => Promise.resolve([]),
    };
    registerVisualProvider(() => custom);
    expect((await resolveVisualProvider()).name).toBe('stub-recognizer');
  });

  it('disposes provider resources on reset', async () => {
    const dispose = vi.fn();
    registerVisualProvider(() => ({
      name: 'disposable',
      source: 'vision',
      analyze: () => Promise.resolve([]),
      dispose,
    }));
    await resolveVisualProvider();
    await resetVisualProviders();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(isVisualProviderLoaded()).toBe(false);
  });
});

describe('region cache', () => {
  const observations: VisualObservation[] = [
    {
      type: 'visual_observation',
      source: 'vision',
      region,
      observations: ['text_like_content'],
      confidence: 0.5,
      local: true,
    },
  ];

  it('returns a hit only when the pixel digest still matches', () => {
    const cache = new VisualRegionCache();
    const digest = computeRasterDigest(textLikeRaster());
    cache.set(region.id, digest, observations);

    expect(cache.get(region.id, digest)?.observations).toEqual(observations);
    expect(cache.get(region.id, computeRasterDigest(flatRaster()))).toBeNull();
    expect(cache.get('other-region', digest)).toBeNull();
  });

  it('detects a repainted region', () => {
    const before = computeRasterDigest(textLikeRaster());
    const after = computeRasterDigest(
      makeRaster(120, 48, (x, y) => (y % 8 < 4 ? (x % 6 < 3 ? 30 : 200) : 250)),
    );
    expect(before).not.toBe(after);
  });

  it('gives identical pixels an identical digest', () => {
    expect(computeRasterDigest(textLikeRaster())).toBe(computeRasterDigest(textLikeRaster()));
  });

  it('encodes dimensions so a resized region misses', () => {
    expect(computeRasterDigest(flatRaster(64, 64))).not.toBe(computeRasterDigest(flatRaster(32, 32)));
  });

  it('stores no pixels — only a digest and derived labels', () => {
    const cache = new VisualRegionCache();
    cache.set(region.id, computeRasterDigest(textLikeRaster()), observations);
    const serialized = JSON.stringify(Array.from(Object.entries(cache)));
    expect(serialized).not.toMatch(/Uint8/);
    expect(cache.size).toBe(1);
  });

  it('stays bounded under sustained use', () => {
    const cache = new VisualRegionCache(4);
    for (let i = 0; i < 50; i++) cache.set(`region-${i}`, `digest-${i}`, observations);
    expect(cache.size).toBe(4);
    expect(cache.get('region-0', 'digest-0')).toBeNull();
    expect(cache.get('region-49', 'digest-49')?.observations).toEqual(observations);
  });

  it('clears fully on dispose', () => {
    const cache = new VisualRegionCache();
    cache.set(region.id, 'd', observations);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(0);
  });
});
