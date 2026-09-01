// M5 — sanitizer primitive unit tests: alias allocation, category normalisation,
// literal redaction, the text `Sanitizer`, region merging, and pixel masking.
// Every value is synthetic (CONTRIBUTING.md §13/§15).

import { describe, expect, it } from 'vitest';
import {
  applyMasks,
  createAliasAllocator,
  createSanitizer,
  mergeMaskRegions,
  redact,
  toSensitiveCategory,
  type MaskInput,
} from '../../extension/src/sanitizer';
import { makeRaster } from '../helpers/raster';
import type { SensitiveEntity } from '../../extension/src/types/contracts';

function entity(overrides: Partial<SensitiveEntity> = {}): SensitiveEntity {
  return { id: 'e1', category: 'EMAIL', source: 'DOM', confidence: 1, reasons: ['pattern'], ...overrides };
}

describe('toSensitiveCategory', () => {
  it('normalises M2 detector variants to declared categories', () => {
    expect(toSensitiveCategory('PHONE_NUMBER')).toBe('PHONE');
    expect(toSensitiveCategory('PAYMENT_CARD')).toBe('PAYMENT');
    expect(toSensitiveCategory('CREDENTIAL')).toBe('PASSWORD');
    expect(toSensitiveCategory('EMAIL')).toBe('EMAIL');
  });

  it('falls back to CUSTOM for unknown categories (never guesses non-sensitive)', () => {
    expect(toSensitiveCategory('SOMETHING_NEW')).toBe('CUSTOM');
  });
});

describe('createAliasAllocator', () => {
  it('is stable: the same value re-uses its alias', () => {
    const a = createAliasAllocator();
    const first = a.aliasFor('x@corp.test', 'EMAIL');
    const second = a.aliasFor('x@corp.test', 'EMAIL');
    expect(first.alias).toBe('USER_EMAIL_1');
    expect(second.alias).toBe('USER_EMAIL_1');
    expect(second.isNew).toBe(false);
    expect(a.bindings()).toHaveLength(1);
  });

  it('is unique per category and preserves semantic type', () => {
    const a = createAliasAllocator();
    expect(a.aliasFor('x@corp.test', 'EMAIL').alias).toBe('USER_EMAIL_1');
    expect(a.aliasFor('y@corp.test', 'EMAIL').alias).toBe('USER_EMAIL_2');
    expect(a.aliasFor('555-0100', 'PHONE').alias).toBe('USER_PHONE_1');
  });

  it('an alias contains no fragment of the secret it replaces', () => {
    const a = createAliasAllocator();
    const secret = 'hunter2-secret';
    const { alias } = a.aliasFor(secret, 'PASSWORD');
    expect(secret).not.toContain(alias);
    expect(alias).not.toContain('hunter');
  });
});

describe('redact', () => {
  it('replaces every occurrence with the alias, literally', () => {
    const out = redact('a@x.test then a@x.test', [{ value: 'a@x.test', alias: 'USER_EMAIL_1' }]);
    expect(out).toBe('USER_EMAIL_1 then USER_EMAIL_1');
  });

  it('replaces longer values first so substrings cannot corrupt the result', () => {
    const out = redact('a@x.testlong and a@x.test', [
      { value: 'a@x.test', alias: 'USER_EMAIL_2' },
      { value: 'a@x.testlong', alias: 'USER_EMAIL_1' },
    ]);
    expect(out).toBe('USER_EMAIL_1 and USER_EMAIL_2');
  });

  it('ignores empty values and leaves unmatched text unchanged', () => {
    expect(redact('nothing here', [{ value: '', alias: 'X' }])).toBe('nothing here');
  });
});

describe('createSanitizer — text primitive', () => {
  it('aliases entities with text and preserves the rest of the page', async () => {
    const s = createSanitizer();
    const r = await s.sanitize(
      [entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' })],
      'Contact alice@corp.test about Q3.',
    );
    expect(r.text).toBe('Contact USER_EMAIL_1 about Q3.');
    expect(r.text).not.toContain('alice@corp.test');
    expect(r.aliases).toEqual(['USER_EMAIL_1']);
  });

  it('allocates aliases in document order regardless of detection order', async () => {
    const s = createSanitizer();
    const r = await s.sanitize(
      [
        entity({ id: 'e2', category: 'EMAIL', text: 'second@corp.test' }),
        entity({ id: 'e1', category: 'EMAIL', text: 'first@corp.test' }),
      ],
      'first@corp.test ... second@corp.test',
    );
    expect(r.text).toBe('USER_EMAIL_1 ... USER_EMAIL_2');
  });

  it('ignores entities with no text and tolerates empty input', async () => {
    const s = createSanitizer();
    expect(await s.sanitize([], '')).toEqual({ text: '', aliases: [] });
    expect(await s.sanitize([entity({ text: undefined })], 'plain text')).toEqual({
      text: 'plain text',
      aliases: [],
    });
  });
});

describe('mergeMaskRegions', () => {
  const mk = (id: string, bbox: [number, number, number, number]): MaskInput => ({
    bbox,
    findingId: id,
    source: 'VISION',
  });

  it('keeps disjoint regions separate, sorted top-to-bottom', () => {
    const out = mergeMaskRegions([mk('b', [0, 500, 50, 50]), mk('a', [0, 0, 50, 50])]);
    expect(out).toHaveLength(2);
    expect(out[0]!.bbox).toEqual([0, 0, 50, 50]);
    expect(out[1]!.bbox).toEqual([0, 500, 50, 50]);
  });

  it('merges overlapping regions into their union and preserves all finding ids', () => {
    const out = mergeMaskRegions([mk('r1', [0, 0, 60, 60]), mk('r2', [40, 40, 60, 60])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.bbox).toEqual([0, 0, 100, 100]);
    expect(out[0]!.findingIds).toEqual(['r1', 'r2']);
  });

  it('coalesces a bridged chain of overlaps to a fixpoint', () => {
    const out = mergeMaskRegions([
      mk('a', [0, 0, 30, 10]),
      mk('c', [50, 0, 30, 10]),
      mk('b', [25, 0, 30, 10]), // bridges a and c
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.findingIds).toEqual(['a', 'b', 'c']);
    expect(out[0]!.bbox).toEqual([0, 0, 80, 10]);
  });

  it('reports a merged region spanning mixed sources as FUSED', () => {
    const out = mergeMaskRegions([
      { bbox: [0, 0, 60, 60], findingId: 'r1', source: 'VISION' },
      { bbox: [40, 40, 60, 60], findingId: 'r2', source: 'OCR' },
    ]);
    expect(out[0]!.source).toBe('FUSED');
  });
});

describe('applyMasks — local pixel masking', () => {
  const px = (buf: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
    const p = (y * buf.width + x) * 4;
    return [buf.data[p], buf.data[p + 1], buf.data[p + 2], buf.data[p + 3]];
  };

  it('fills the region opaque black and leaves the rest untouched', () => {
    const raster = makeRaster(20, 20, () => 200);
    const masked = applyMasks(raster, [[5, 5, 10, 10]]);
    expect(px(masked, 10, 10)).toEqual([0, 0, 0, 255]); // inside the region
    expect(px(masked, 0, 0)).toEqual([200, 200, 200, 255]); // outside the region
  });

  it('does not mutate the input buffer', () => {
    const raster = makeRaster(8, 8, () => 200);
    const before = new Uint8ClampedArray(raster.data);
    applyMasks(raster, [[0, 0, 8, 8]]);
    expect(raster.data).toEqual(before);
  });

  it('clips regions that exceed the buffer bounds without error', () => {
    const raster = makeRaster(10, 10, () => 200);
    const masked = applyMasks(raster, [[8, 8, 100, 100]]);
    expect(px(masked, 9, 9)).toEqual([0, 0, 0, 255]);
  });
});
