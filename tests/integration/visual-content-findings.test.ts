// M5 OCR/vision integration — genuine visual content findings flow through the real
// service, get mapped to page coordinates, and are enforced as INDEPENDENT masks.
// Covers Priority 2 items: OCR result→finding, coordinate conversion end-to-end,
// multiple independent findings, visual masking, OCR unavailable, OCR failure, and
// "no fabricated detections". Uses injected fakes — no real Chrome, no real engine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisualPerceptionService } from '../../extension/src/perception/visual/service';
import {
  registerVisualProvider,
  resetVisualProviders,
} from '../../extension/src/perception/visual/providers/registry';
import {
  registerVisualContentAnalyzer,
  resetVisualContentAnalyzer,
} from '../../extension/src/perception/visual/content-analyzer';
import type {
  RasterizeFn,
  RawVisualContentFinding,
  VisualCapabilities,
  VisualProvider,
} from '../../extension/src/perception/visual/types';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';
import { enforcePrivacy } from '../../extension/src/sanitizer/enforce';
import { createLocalVault } from '../../extension/src/vault';
import { buildScanSummary } from '../../extension/src/scan/summary';
import { textLikeRaster } from '../helpers/raster';

const CAPABLE: VisualCapabilities = { backends: ['cpu'], canRasterize: true, hasDocument: true };
const CAPTURE = 'data:image/png;base64,Q0FOQVJZ';

function candidate(overrides: Partial<DomVisualCandidate> = {}): DomVisualCandidate {
  return { kind: 'image', rect: { x: 0, y: 0, width: 300, height: 200 }, hasAccessibleText: false, domTextLength: 0, ...overrides };
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

// A structural provider that always says "text-like" so the run reaches analysis.
function registerTextLikeProvider(): void {
  const provider: VisualProvider = {
    name: 'test-structural',
    source: 'vision',
    analyze: () =>
      Promise.resolve([
        {
          type: 'visual_observation' as const,
          source: 'vision' as const,
          region: { id: 'x', x: 0, y: 0, width: 1, height: 1 },
          observations: ['graphic_content' as const],
          confidence: 0.9,
          local: true as const,
        },
      ]),
  };
  registerVisualProvider(() => provider);
}

/** Register a fake OCR/vision engine returning fixed raster-space findings. */
function registerFakeEngine(
  findings: RawVisualContentFinding[] | (() => Promise<never>),
): void {
  registerVisualContentAnalyzer(() => ({
    name: 'fake-ocr',
    analyze: typeof findings === 'function' ? findings : () => Promise.resolve({ status: 'ok', findings }),
  }));
}

let capture: ReturnType<typeof vi.fn<() => Promise<string>>>;
let rasterize: ReturnType<typeof vi.fn<RasterizeFn>>;

beforeEach(async () => {
  await resetVisualProviders();
  await resetVisualContentAnalyzer();
  registerTextLikeProvider();
  capture = vi.fn<() => Promise<string>>(() => Promise.resolve(CAPTURE));
  // Rasterizer returns a fixed 120x48 raster so coordinate math is deterministic.
  rasterize = vi.fn<RasterizeFn>(() => Promise.resolve(textLikeRaster(120, 48)));
});

afterEach(async () => {
  await resetVisualProviders();
  await resetVisualContentAnalyzer();
});

function service() {
  return createVisualPerceptionService({ captureViewport: capture, rasterize, capabilities: CAPABLE });
}

describe('OCR/vision content findings through the service', () => {
  it('reports not_available and zero findings when no engine is registered (honest, no fabrication)', async () => {
    const result = await service().run(snapshot());
    expect(result.status).toBe('completed');
    expect(result.contentStatus).toBe('not_available');
    expect(result.contentFindings).toEqual([]);
  });

  it('maps an OK engine finding into a document-coordinate, region-tagged finding', async () => {
    // Region is the full candidate clamped to viewport: x0 y0 300x200. Raster is 120x48,
    // so a raster box (60,24,30,12) maps to region px (150,100,75,50).
    registerFakeEngine([{ category: 'EMAIL', confidence: 0.95, bbox: [60, 24, 30, 12], text: 'a@b.test' }]);
    const result = await service().run(snapshot());

    expect(result.contentStatus).toBe('ok');
    expect(result.contentFindings).toHaveLength(1);
    const f = result.contentFindings![0]!;
    expect(f.category).toBe('EMAIL');
    expect(f.regionId).toMatch(/^r-/);
    expect(f.provider).toBe('fake-ocr');
    expect(f.bbox).toEqual([150, 100, 75, 50]);
  });

  it('preserves MULTIPLE independent findings from one region', async () => {
    registerFakeEngine([
      { category: 'EMAIL', confidence: 0.9, bbox: [0, 0, 20, 10] },
      { category: 'PHONE', confidence: 0.9, bbox: [80, 30, 20, 10] },
    ]);
    const result = await service().run(snapshot());
    expect(result.contentFindings).toHaveLength(2);
    expect(new Set(result.contentFindings!.map((f) => f.category))).toEqual(new Set(['EMAIL', 'PHONE']));
  });

  it('reports failed and fabricates nothing when the engine throws', async () => {
    registerFakeEngine(() => Promise.reject(new Error('model crashed')));
    const result = await service().run(snapshot());
    expect(result.status).toBe('completed');
    expect(result.contentStatus).toBe('failed');
    expect(result.contentFindings).toEqual([]);
  });

  it('drives INDEPENDENT masks through M4→M5 (no overwrite, no merge of disjoint boxes)', async () => {
    registerFakeEngine([
      { category: 'EMAIL', confidence: 0.95, bbox: [0, 0, 10, 10] }, // → region px (0,0,25,~42)
      { category: 'PHONE', confidence: 0.95, bbox: [96, 36, 20, 10] }, // → far-apart box
    ]);
    const result = await service().run(snapshot());

    const enforced = await enforcePrivacy({
      signals: { entities: [], visual: result, restricted: false },
      pageText: 'no raw values here',
      sessionId: 'test',
      vault: createLocalVault(),
    });

    // Two disjoint visual findings → two independent mask directives, both masked.
    expect(enforced.visualMasks).toHaveLength(2);
    const masked = enforced.findings.filter((f) => f.disposition === 'masked');
    expect(masked.length).toBeGreaterThanOrEqual(2);
  });

  it('escalates a critical categorized image finding to a page-level block', async () => {
    registerFakeEngine([{ category: 'PASSWORD', confidence: 0.95, bbox: [10, 10, 40, 20] }]);
    const result = await service().run(snapshot());

    const enforced = await enforcePrivacy({
      signals: { entities: [], visual: result, restricted: false },
      pageText: 'secret painted in an image',
      sessionId: 'test',
      vault: createLocalVault(),
    });

    expect(enforced.blocked).toBe(true);
    // Fail closed: no cleartext emitted when blocked.
    expect(enforced.sanitizedText).toBe('');
  });

  it('never leaks recognized OCR text into the enforcement result', async () => {
    const canary = 'CANARY_OCR_555@example.test';
    registerFakeEngine([{ category: 'EMAIL', confidence: 0.95, bbox: [0, 0, 20, 10], text: canary }]);
    const result = await service().run(snapshot());

    const enforced = await enforcePrivacy({
      signals: { entities: [], visual: result, restricted: false },
      pageText: 'body text without the canary',
      sessionId: 'test',
      vault: createLocalVault(),
    });

    expect(JSON.stringify(enforced)).not.toContain(canary);
  });

  it('tags an OCR-sourced finding as OCR through M4→M5→summary (OCR_REGION, not IMAGE_REGION)', async () => {
    // A content analyzer that declares source OCR — as the real Tesseract bridge does.
    registerVisualContentAnalyzer(() => ({
      name: 'fake-ocr',
      source: 'OCR',
      analyze: () =>
        Promise.resolve({
          status: 'ok' as const,
          findings: [{ category: 'EMAIL' as const, confidence: 0.95, bbox: [0, 0, 20, 10] }],
        }),
    }));
    const result = await service().run(snapshot());
    // The service stamps the analyzer's source onto the content finding.
    expect(result.contentFindings?.[0]?.source).toBe('OCR');

    const enforced = await enforcePrivacy({
      signals: { entities: [], visual: result, restricted: false },
      pageText: 'body text',
      sessionId: 'test',
      vault: createLocalVault(),
    });
    // The mask directive carries OCR provenance…
    expect(enforced.visualMasks[0]?.source).toBe('OCR');
    // …and the display summary labels it as an OCR region, distinct from a plain image.
    const summary = buildScanSummary(enforced, snapshot().viewport?.height);
    expect(summary.findings[0]?.displayId).toBe('OCR_REGION_1');
    expect(summary.findings[0]?.source).toBe('OCR');
  });
});
