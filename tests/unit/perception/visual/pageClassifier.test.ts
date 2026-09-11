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

describe('captcha and error-page detection (Phase 1)', () => {
  it("flags reCAPTCHA marker text as captcha with confidence >= 0.9", () => {
    const result = classifyPage([], 'Please complete the reCAPTCHA challenge to continue');
    expect(result.pageType).toBe('captcha');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('flags h-captcha markers in field names as captcha', () => {
    const result = classifyPage(
      [{ selector: '#c', tag: 'input', name: 'h-captcha-response', disabled: false }],
      'Verify you are human',
    );
    expect(result.pageType).toBe('captcha');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("flags human-verification wording as captcha", () => {
    const result = classifyPage([], "I'm not a robot — human verification required");
    expect(result.pageType).toBe('captcha');
  });

  it("flags '404 not found' pages as error_page", () => {
    const result = classifyPage([], '404 not found — the page you requested does not exist');
    expect(result.pageType).toBe('error_page');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('captcha outranks payment/auth signals', () => {
    const result = classifyPage(
      [{ selector: '#c', tag: 'input', inputType: 'password', disabled: false }],
      'Sign in — complete the captcha to continue',
    );
    expect(result.pageType).toBe('captcha');
  });
});

  it('does not flag prices/IDs containing 404/500/403 as error pages', () => {
    expect(classifyPage([], 'Fee due ₹18,500').pageType).toBe('general');
    expect(classifyPage([], 'Order ORDER-827364 · Roll ROLL-2026-118').pageType).toBe('general');
    expect(classifyPage([], 'Error 404 — page not found').pageType).toBe('error_page');
  });
