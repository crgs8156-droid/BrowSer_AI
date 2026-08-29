// M3 — OCR boundary honesty.
//
// The point of these tests is that PrivAgent reports NOTHING rather than something
// plausible when it has no recognizer. Earlier scaffolding returned a hard-coded
// 'Sample OCR Text' for any input; a regression to that behaviour would feed
// fabricated page content into later milestones, so it is asserted against directly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOcrEngine,
  isOcrAvailable,
  registerOcrRecognizer,
  resetOcrRecognizer,
} from '../../extension/src/perception/ocr';
import type { OcrImage, OcrResult } from '../../extension/src/perception/ocr';
import { textLikeRaster } from '../helpers/raster';

afterEach(async () => {
  await resetOcrRecognizer();
});

describe('OCR engine without a registered recognizer', () => {
  it('reports no text at all', async () => {
    expect(await createOcrEngine().recognize(textLikeRaster())).toEqual([]);
  });

  it('never fabricates a transcription', async () => {
    const results = await createOcrEngine().recognize(textLikeRaster());
    expect(JSON.stringify(results)).not.toMatch(/Sample OCR Text/i);
    expect(results.every((r: OcrResult) => r.text.length === 0)).toBe(true);
  });

  it('advertises its own unavailability', () => {
    expect(isOcrAvailable()).toBe(false);
  });

  it('handles empty, null and degenerate input', async () => {
    const engine = createOcrEngine();
    expect(await engine.recognize(null)).toEqual([]);
    expect(await engine.recognize(undefined)).toEqual([]);
    expect(await engine.recognize({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toEqual(
      [],
    );
  });
});

describe('OCR engine with a registered recognizer', () => {
  const recognized: OcrResult[] = [
    { text: 'CANARY_TOKEN_001', confidence: 0.9, bbox: [1, 2, 3, 4] },
  ];

  it('does not load the recognizer until recognition is actually requested', async () => {
    const factory = vi.fn(() => ({
      name: 'mock',
      recognize: () => Promise.resolve(recognized),
    }));
    registerOcrRecognizer(factory);

    expect(factory).not.toHaveBeenCalled();
    expect(isOcrAvailable()).toBe(true);

    await createOcrEngine().recognize(textLikeRaster());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('loads the recognizer at most once across engines', async () => {
    const factory = vi.fn(() => ({
      name: 'mock',
      recognize: () => Promise.resolve(recognized),
    }));
    registerOcrRecognizer(factory);

    await createOcrEngine().recognize(textLikeRaster());
    await createOcrEngine().recognize(textLikeRaster());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('returns exactly what the recognizer produced, unmodified', async () => {
    registerOcrRecognizer(() => ({ name: 'mock', recognize: () => Promise.resolve(recognized) }));
    expect(await createOcrEngine().recognize(textLikeRaster())).toEqual(recognized);
  });

  it('accepts both RasterRegion and ImageData-shaped input', async () => {
    const seen: OcrImage[] = [];
    registerOcrRecognizer(() => ({
      name: 'mock',
      recognize: (image: OcrImage) => {
        seen.push(image);
        return Promise.resolve([]);
      },
    }));

    const engine = createOcrEngine();
    await engine.recognize(textLikeRaster());
    await engine.recognize({ width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) });
    expect(seen).toHaveLength(2);
  });

  it('releases recognizer resources on reset', async () => {
    const dispose = vi.fn();
    registerOcrRecognizer(() => ({
      name: 'mock',
      recognize: () => Promise.resolve([]),
      dispose,
    }));
    await createOcrEngine().recognize(textLikeRaster());
    await resetOcrRecognizer();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(isOcrAvailable()).toBe(false);
    expect(await createOcrEngine().recognize(textLikeRaster())).toEqual([]);
  });
});
