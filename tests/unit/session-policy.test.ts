import { describe, expect, it } from 'vitest';
import { isOriginAllowlisted, originOfUrl } from '../../extension/src/agent/session-policy';

describe('navigation allowlist helpers (Part C)', () => {
  it('extracts https origins, null otherwise', () => {
    expect(originOfUrl('https://site.test/page?q=1')).toBe('https://site.test');
    expect(originOfUrl('http://site.test/')).toBeNull();
    expect(originOfUrl('not-a-url')).toBeNull();
  });

  it('matches exact origins and true subdomains with port equality', () => {
    expect(isOriginAllowlisted('https://site.test/a', ['https://site.test'])).toBe(true);
    expect(isOriginAllowlisted('https://sub.site.test/a', ['https://site.test'])).toBe(true);
    expect(isOriginAllowlisted('https://evil.com/', ['https://site.test'])).toBe(false);
    expect(isOriginAllowlisted('https://site.test.evil.com/', ['https://site.test'])).toBe(false);
    expect(isOriginAllowlisted('http://site.test/', ['https://site.test'])).toBe(false);
    expect(isOriginAllowlisted('::bad::', ['https://site.test'])).toBe(false);
  });
});
