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
