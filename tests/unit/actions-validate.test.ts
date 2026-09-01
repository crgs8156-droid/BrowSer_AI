import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_POLICY,
  validateActionPolicy,
  validateActionSchema,
} from '../../extension/src/actions/validate';

describe('action schema validation', () => {
  it('accepts each valid action shape', () => {
    expect(validateActionSchema({ action: 'CLICK', target: '#a' }).valid).toBe(true);
    expect(validateActionSchema({ action: 'TYPE', target: '#a', value: 'USER_EMAIL_1' }).valid).toBe(true);
    expect(validateActionSchema({ action: 'SELECT', target: '#a', value: 'x' }).valid).toBe(true);
    expect(validateActionSchema({ action: 'SCROLL', amount: 300 }).valid).toBe(true);
    expect(validateActionSchema({ action: 'NAVIGATE', url: 'https://a.test/x' }).valid).toBe(true);
  });

  it('rejects non-objects, unknown kinds, and missing fields', () => {
    expect(validateActionSchema(null).valid).toBe(false);
    expect(validateActionSchema('CLICK').valid).toBe(false);
    expect(validateActionSchema({ action: 'EVAL', target: '#a' }).valid).toBe(false);
    expect(validateActionSchema({ action: 'CLICK' }).reason).toBe('SCHEMA_TARGET_REQUIRED');
    expect(validateActionSchema({ action: 'TYPE', target: '#a' }).reason).toBe('SCHEMA_VALUE_REQUIRED');
    expect(validateActionSchema({ action: 'SCROLL', amount: 'x' }).valid).toBe(false);
    expect(validateActionSchema({ action: 'NAVIGATE' }).valid).toBe(false);
  });

  it('rejects unexpected extra fields (no payload smuggling)', () => {
    const result = validateActionSchema({ action: 'CLICK', target: '#a', js: 'alert(1)' });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('SCHEMA_UNEXPECTED_FIELD');
  });
});

describe('action policy validation', () => {
  it('always accepts alias-shaped TYPE values', () => {
    const result = validateActionPolicy(
      { action: 'TYPE', target: '#a', value: 'USER_EMAIL_1' },
      DEFAULT_ACTION_POLICY,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects TYPE values that contain detectable PII', () => {
    const result = validateActionPolicy(
      { action: 'TYPE', target: '#a', value: 'CANARY_EMAIL_001@example.test' },
      DEFAULT_ACTION_POLICY,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('POLICY_VALUE_LOOKS_SENSITIVE');
  });

  it('accepts clean literal values', () => {
    const result = validateActionPolicy(
      { action: 'TYPE', target: '#a', value: 'hello world' },
      DEFAULT_ACTION_POLICY,
    );
    expect(result.valid).toBe(true);
  });

  it('denies NAVIGATE by default and outside the allowlist', () => {
    const denied = validateActionPolicy(
      { action: 'NAVIGATE', url: 'https://evil.test/x' },
      DEFAULT_ACTION_POLICY,
    );
    expect(denied.valid).toBe(false);
    expect(denied.reason).toBe('POLICY_URL_NOT_ALLOWLISTED');
  });

  it('allows NAVIGATE only to allowlisted https origins', () => {
    const policy = { ...DEFAULT_ACTION_POLICY, navigationAllowlist: ['https://app.test'] };
    expect(validateActionPolicy({ action: 'NAVIGATE', url: 'https://app.test/x' }, policy).valid).toBe(true);
    expect(
      validateActionPolicy({ action: 'NAVIGATE', url: 'http://app.test/x' }, policy).reason,
    ).toBe('POLICY_URL_NOT_HTTPS');
    expect(
      validateActionPolicy({ action: 'NAVIGATE', url: 'https://evil.test/x' }, policy).valid,
    ).toBe(false);
  });

  it('rejects malformed and oversized NAVIGATE urls', () => {
    expect(validateActionPolicy({ action: 'NAVIGATE', url: '::::' }, DEFAULT_ACTION_POLICY).reason).toBe(
      'POLICY_URL_MALFORMED',
    );
    expect(
      validateActionPolicy({ action: 'NAVIGATE', url: `https://a.test/${'x'.repeat(3000)}` }, DEFAULT_ACTION_POLICY)
        .reason,
    ).toBe('POLICY_URL_TOO_LONG');
  });

  it('bounds SCROLL amounts', () => {
    expect(validateActionPolicy({ action: 'SCROLL', amount: 500 }, DEFAULT_ACTION_POLICY).valid).toBe(true);
    expect(validateActionPolicy({ action: 'SCROLL', amount: 999_999 }, DEFAULT_ACTION_POLICY).reason).toBe(
      'POLICY_SCROLL_TOO_LARGE',
    );
  });
});
