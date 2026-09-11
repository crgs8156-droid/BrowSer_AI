import { describe, expect, it } from 'vitest';
import { detectPII } from '../../../extension/src/perception/pii';
import { normalizeNumerals } from '../../../extension/src/sanitizer/normalize';
import { createSanitizer, toSensitiveCategory } from '../../../extension/src/sanitizer';

describe('Devanagari numeral support (Phase 2)', () => {
  it('normalizes Devanagari digits to ASCII (identity on ASCII)', () => {
    expect(normalizeNumerals('४५६७ ८९०१ २३४५')).toBe('4567 8901 2345');
    expect(normalizeNumerals('ABCDE१२३४F')).toBe('ABCDE1234F');
    expect(normalizeNumerals('plain 123')).toBe('plain 123');
  });

  it('detects Aadhaar written in Devanagari digits', () => {
    const entities = detectPII('मेरा आधार ४५६७ ८९०१ २३४५ है');
    const hit = entities.find((e) => e.category === 'AADHAAR');
    expect(hit).toBeDefined();
    // mapped back to the ORIGINAL slice so literal redaction still works
    expect(hit!.text).toContain('४५६७');
  });

  it('detects PAN with Devanagari digits', () => {
    const entities = detectPII('PAN: ABCDE१२३४F');
    expect(entities.some((e) => e.category === 'PAN')).toBe(true);
  });

  it('leaves normal ASCII detection unchanged', () => {
    expect(detectPII('call 555-123-4567').some((e) => toSensitiveCategory(e.category) === 'PHONE')).toBe(true);
    expect(detectPII('nothing sensitive here')).toHaveLength(0);
  });

  it('sanitizer redacts the original Devanagari value (not the normalized copy)', async () => {
    const text = 'मेरा आधार ४५६७ ८९०१ २३४५ है';
    const entities = detectPII(text);
    const sanitizer = createSanitizer();
    const result = await sanitizer.sanitize(entities, text);
    expect(result.text).not.toContain('४५६७');
    expect(result.text).toContain('USER_AADHAAR_1');
  });
});
