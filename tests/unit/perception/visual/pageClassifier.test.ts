import { describe, expect, it } from 'vitest';
import { classifyPage } from '../../../../extension/src/perception/visual/pageClassifier';
import type { FieldStructure } from '../../../../extension/src/types/messages';

function field(partial: Partial<FieldStructure> & { tag: FieldStructure['tag'] }): FieldStructure {
  return { selector: `#${partial.inputType ?? partial.tag}`, disabled: false, ...partial };
}

describe('rule-based page classifier', () => {
  it('classifies a payment page (tel input + card wording) with explicit confidence', () => {
    const result = classifyPage(
      [
        field({ tag: 'input', inputType: 'tel', label: 'Card number', name: 'card' }),
        field({ tag: 'input', inputType: 'text', label: 'CVV' }),
      ],
      'Complete your purchase',
    );
    expect(result.pageType).toBe('payment');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('classifies an auth page with a password field', () => {
    const result = classifyPage(
      [
        field({ tag: 'input', inputType: 'password', label: 'Password' }),
        field({ tag: 'input', inputType: 'text', label: 'Username' }),
      ],
      'Sign in to your account',
    );
    expect(result.pageType).toBe('auth');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('payment outranks auth when both signals exist (priority order)', () => {
    const result = classifyPage(
      [
        field({ tag: 'input', inputType: 'password', label: 'Password' }),
        field({ tag: 'input', inputType: 'tel', label: 'Card number' }),
      ],
      'Pay by card',
    );
    expect(result.pageType).toBe('payment');
  });

  it('classifies a generic 3+-field page as form (structural confidence)', () => {
    const result = classifyPage(
      [
        field({ tag: 'input', inputType: 'text', label: 'First' }),
        field({ tag: 'input', inputType: 'text', label: 'Second' }),
        field({ tag: 'input', inputType: 'text', label: 'Third' }),
      ],
      'Tell us about yourself',
    );
    expect(result.pageType).toBe('form');
    expect(result.confidence).toBeCloseTo(0.6);
  });

  it('detects medical wording when no structural rule matched first', () => {
    const result = classifyPage(
      [field({ tag: 'input', inputType: 'text', label: 'Notes' })],
      'Enter the diagnosis for this patient',
    );
    expect(result.pageType).toBe('medical');
  });

  it('falls back to general for a plain page', () => {
    const result = classifyPage([field({ tag: 'input', inputType: 'text', label: 'Search' })], 'Search the site');
    expect(result).toEqual({ pageType: 'general', confidence: 0.6 });
  });

  it('tolerates missing structure and malformed text', () => {
    expect(classifyPage(undefined, undefined as unknown as string).pageType).toBe('general');
    expect(classifyPage([], 42 as unknown as string).pageType).toBe('general');
  });
});
