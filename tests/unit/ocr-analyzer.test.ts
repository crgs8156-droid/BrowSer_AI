// Unit tests for the OCR → sensitivity content analyzer (extension/src/perception/
// visual/ocr-analyzer.ts). A FAKE OcrRecognizer is injected via the OCR registry so
// these run fast, offline, and deterministically — production uses the real
// Tesseract recognizer (CONTRIBUTING.md §12, requirement I). Raw canary values only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOcrContentAnalyzer } from '../../extension/src/perception/visual/ocr-analyzer';
import {
  registerOcrRecognizer,
  resetOcrRecognizer,
  type OcrImage,
  type OcrResult,
} from '../../extension/src/perception/ocr';
import type { RasterRegion } from '../../extension/src/perception/visual/types';
import type { VisualRegion } from '../../extension/src/types/contracts';

const RASTER: RasterRegion = { width: 200, height: 40, data: new Uint8ClampedArray(200 * 40 * 4) };
const REGION: VisualRegion = { id: 'r-1', x: 0, y: 0, width: 200, height: 40 };

/** Register a fake recognizer that returns fixed word boxes for any image. */
function fakeRecognizer(words: OcrResult[], onCall?: (image: OcrImage) => void): void {
  registerOcrRecognizer(() => ({
    name: 'fake-ocr',
    recognize: async (image: OcrImage) => {
      onCall?.(image);
      return words;
    },
  }));
}

function word(text: string, bbox: [number, number, number, number], confidence = 0.9): OcrResult {
  return { text, bbox, confidence };
}

beforeEach(async () => {
  await resetOcrRecognizer();
});
afterEach(async () => {
  await resetOcrRecognizer();
});

describe('OCR content analyzer — engine availability', () => {
  it('reports not_available when no recognizer is registered (never fabricates)', async () => {
    const result = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(result).toEqual({ status: 'not_available', findings: [] });
  });

  it('reports failed when the recognizer throws (fail closed)', async () => {
    registerOcrRecognizer(() => ({
      name: 'broken-ocr',
      recognize: async () => {
        throw new Error('OCR_ENGINE_UNAVAILABLE: worker failed to load');
      },
    }));
    const result = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(result).toEqual({ status: 'failed', findings: [] });
  });

  it('reports ok with zero findings when the engine reads no text (empty OCR)', async () => {
    fakeRecognizer([]);
    const result = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(result).toEqual({ status: 'ok', findings: [] });
  });

  it('reports ok with zero findings when recognized text has no sensitive data', async () => {
    fakeRecognizer([word('Welcome', [0, 0, 60, 20]), word('home', [70, 0, 40, 20])]);
    const result = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(result.status).toBe('ok');
    expect(result.findings).toEqual([]);
  });
});

describe('OCR content analyzer — classification of recognized text', () => {
  it('classifies a recognized email and returns its word bbox + text', async () => {
    fakeRecognizer([word('canary_person_1@example.test', [10, 5, 120, 18], 0.8)]);
    const { status, findings } = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');

    expect(status).toBe('ok');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'EMAIL',
      text: 'canary_person_1@example.test',
      bbox: [10, 5, 120, 18],
    });
    // Confidence reflects the OCR reading (0.8), not the regex certainty (1).
    expect(findings[0]?.confidence).toBeCloseTo(0.8, 5);
  });

  it('unions the boxes of every word a multi-token value spans (phone)', async () => {
    // A phone split across three OCR word boxes on one line.
    fakeRecognizer([
      word('(555)', [10, 4, 40, 16], 0.9),
      word('123-4567', [55, 4, 70, 16], 0.7),
      word('ext', [130, 4, 20, 16], 0.9),
    ]);
    const { findings } = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');

    const phone = findings.find((f) => f.category === 'PHONE');
    expect(phone).toBeDefined();
    // Union of the two boxes the number covers: x 10..125 → [10,4,115,16].
    expect(phone?.bbox).toEqual([10, 4, 115, 16]);
    // Averaged OCR confidence of the covered words (0.9, 0.7) → 0.8.
    expect(phone?.confidence).toBeCloseTo(0.8, 5);
  });

  it('emits multiple independent findings recognized in one region', async () => {
    fakeRecognizer([
      word('a@b.test', [0, 0, 60, 16]),
      word('4111111111111111', [0, 20, 120, 16]), // valid-Luhn synthetic card
    ]);
    const { findings } = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    const categories = findings.map((f) => f.category).sort();
    expect(categories).toEqual(['EMAIL', 'PAYMENT']);
  });

  it('classifies a recognized credential as PASSWORD (normalized category)', async () => {
    fakeRecognizer([word('api_key:AKIA1234567890', [5, 5, 150, 16], 0.6)]);
    const { findings } = await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(findings[0]?.category).toBe('PASSWORD');
  });

  it('passes the analyzed raster through to the recognizer', async () => {
    let seen: OcrImage | null = null;
    fakeRecognizer([], (image) => {
      seen = image;
    });
    await createOcrContentAnalyzer().analyze(RASTER, REGION, 'cpu');
    expect(seen).toBe(RASTER);
  });
});
