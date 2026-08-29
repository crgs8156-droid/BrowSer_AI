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

// OCR coverage moved to tests/unit/ocr.test.ts in M3: the placeholder engine used to
// return a hard-coded 'Sample OCR Text' for any input, which the new tests assert
// against. The local ImageData polyfill that supported that test is no longer needed.
