// Insert at line 1:
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    width: number;
    height: number;
    data: Uint8ClampedArray;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}
import { describe, expect, it } from 'vitest';
import { createDomCollector } from '../../extension/src/perception/dom';

describe('DomCollector', () => {
  it('collects DOM context safely', async () => {
    const collector = createDomCollector();
    const mockDocument = {
      querySelectorAll: () => [
        { id: 'test', textContent: 'Hello', getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }) },
      ],
    } as unknown as Document;
    const result = await collector.collect(mockDocument);
    expect(result).toEqual([
      {
        id: 'test',
        category: 'UNCLASSIFIED',
        source: 'DOM',
        text: 'Hello',
        bbox: { x: 0, y: 0, width: 100, height: 20 },
        confidence: 1.0,
        reasons: [],
      },
    ]);
  });
});
import { detectPII } from '../../extension/src/perception/pii';
import { captureScreenshot } from '../../extension/src/perception/screenshot';
import { createOcrEngine } from '../../extension/src/perception/ocr';

describe('PII Detection', () => {
  it('detects email addresses', () => {
    const text = 'Contact me at test@example.com';
    const results = detectPII(text);
    expect(results).toEqual([
      {
        id: expect.any(String),
        category: 'EMAIL',
        source: 'DOM',
        text: 'test@example.com',
        confidence: 1.0,
        reasons: ['Matched pattern for EMAIL'],
      },
    ]);
  });
});

describe('Screenshot Capture', () => {
  it('captures a screenshot', async () => {
    const imageData = await captureScreenshot();
    expect(imageData).not.toBeNull();
  });
});

describe('OCR Engine', () => {
  it('recognizes text from an image', async () => {
    const ocrEngine = createOcrEngine();
    const mockImage = new ImageData(100, 100);
    const results = await ocrEngine.recognize(mockImage);
    expect(results).toEqual([
      {
        text: 'Sample OCR Text',
        bbox: [0, 0, 100, 20],
        confidence: 0.95,
      },
    ]);
  });
});
