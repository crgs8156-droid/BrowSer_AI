// Unit tests for the REAL Tesseract recognizer's fail-honest behaviour
// (extension/src/perception/ocr/tesseract.ts).
//
// The wasm engine cannot run under vitest/node (no chrome, no OffscreenCanvas), and
// this suite does NOT attempt to fake recognition — it verifies the ONE thing that
// is deterministic here: when the extension asset context is absent, the recognizer
// throws a tagged OCR_ENGINE_UNAVAILABLE error rather than returning fabricated text
// (requirement B, CONTRIBUTING.md §22). Live recognition is verified manually in Chrome.

import { describe, expect, it } from 'vitest';
import {
  createTesseractRecognizer,
  OCR_ENGINE_UNAVAILABLE,
} from '../../extension/src/perception/ocr/tesseract';
import type { OcrImage } from '../../extension/src/perception/ocr';

const IMAGE: OcrImage = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };

describe('Tesseract recognizer — fail honest outside an extension context', () => {
  it('throws a tagged OCR_ENGINE_UNAVAILABLE error instead of guessing text', async () => {
    // No `chrome.runtime.getURL` in the node test context → assets are unaddressable.
    const recognizer = createTesseractRecognizer();
    await expect(recognizer.recognize(IMAGE)).rejects.toThrowError(
      new RegExp(OCR_ENGINE_UNAVAILABLE),
    );
  });

  it('exposes a stable name and a disposable interface', async () => {
    const recognizer = createTesseractRecognizer();
    expect(recognizer.name).toBe('tesseract.js');
    // dispose is safe to call even when nothing was ever loaded.
    await expect(recognizer.dispose?.()).resolves.toBeUndefined();
  });
});
