import { describe, expect, it } from 'vitest';
import { extractServiceUrl, KNOWN_SERVICES } from '../../../extension/src/agent/services';

describe('extractServiceUrl', () => {
  it('"open gmail" → https://mail.google.com', () => {
    expect(extractServiceUrl('open gmail')).toBe('https://mail.google.com');
  });

  it('"go to youtube" → https://www.youtube.com', () => {
    expect(extractServiceUrl('go to youtube')).toBe('https://www.youtube.com');
  });

  it('"navigate to ilovepdf" → https://www.ilovepdf.com', () => {
    expect(extractServiceUrl('navigate to ilovepdf')).toBe('https://www.ilovepdf.com');
  });

  it('"fill my form" → null (no service named)', () => {
    expect(extractServiceUrl('fill my form')).toBeNull();
  });

  it('"open irctc and book ticket" → https://www.irctc.co.in', () => {
    expect(extractServiceUrl('open irctc and book ticket')).toBe('https://www.irctc.co.in');
  });

  it('every map value is an https origin (never invented at runtime)', () => {
    for (const url of Object.values(KNOWN_SERVICES)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
    }
  });
});
