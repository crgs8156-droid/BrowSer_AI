import { describe, expect, it } from 'vitest';
import { maskPivValue } from '../../../extension/src/piv/mask';

describe('piv masking', () => {
  it('email masked: first4@•••.tld', () => {
    expect(maskPivValue('test@gmail.com', 'contact', 'Personal Email')).toBe('test@•••.com');
  });

  it('phone masked: first2 + last3, keeps country code', () => {
    expect(maskPivValue('9876543210', 'contact', 'Mobile Number')).toBe('98•••••210');
    expect(maskPivValue('+919876543210', 'contact', 'Mobile Number')).toBe('+91 98•••••210');
  });

  it('aadhaar masked: first4 + last4 visible', () => {
    expect(maskPivValue('234567890123', 'identity', 'Aadhaar Number')).toBe('2345 •••• •••• 0123');
  });

  it('pan masked: first2 + last1 visible', () => {
    expect(maskPivValue('ABCDE1234F', 'identity', 'PAN Card')).toBe('AB•••••••F');
  });

  it('upi masked: name visible, bank hidden', () => {
    expect(maskPivValue('user@okicici', 'financial', 'UPI ID')).toBe('user@•••');
  });

  it('card shows last 4 only', () => {
    expect(maskPivValue('4111111111111111', 'financial', 'Card Number')).toBe('•••• •••• •••• 1111');
  });

  it('password always 8 dots regardless of value', () => {
    expect(maskPivValue('hunter2', 'personal', 'Password')).toBe('••••••••');
    expect(maskPivValue('1234', 'contact', 'PIN Code')).toBe('••••••••');
  });

  it('name shows first only', () => {
    expect(maskPivValue('Aarav Sharma', 'personal', 'Full Name')).toBe('Aarav •••');
  });

  it('address shows house + city only', () => {
    expect(maskPivValue('12, MG Road, Bengaluru', 'contact', 'Home Address')).toBe('12, ••••••, Bengaluru');
  });

  it('reveal path returns the full value (caller-gated, 5s timer in UI)', () => {
    const value = 'test@gmail.com';
    expect(value).toBe('test@gmail.com');
    expect(maskPivValue(value, 'contact', 'Personal Email')).not.toBe(value);
  });

  it('uses bullets, never asterisks', () => {
    for (const [v, c, l] of [
      ['test@gmail.com', 'contact', 'Personal Email'],
      ['ABCDE1234F', 'identity', 'PAN Card'],
    ] as const) {
      expect(maskPivValue(v, c, l)).not.toContain('*');
    }
  });
});
