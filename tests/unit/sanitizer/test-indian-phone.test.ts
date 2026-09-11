// Phase 1 — Indian phone comprehensive detection.
// Every value is synthetic (CONTRIBUTING.md §13/§15).

import { describe, expect, it } from 'vitest';
import { createSanitizer } from '../../../extension/src/sanitizer';
import { detectPII } from '../../../extension/src/perception/pii';

async function sanitize(text: string) {
  const entities = detectPII(text);
  return createSanitizer().sanitize(entities, text);
}

function phoneEntities(text: string) {
  return detectPII(text).filter((e) => (e.category as string) === 'PHONE_NUMBER');
}

describe('indian phone detection', () => {
  it('Format 1 — 10 continuous digits', async () => {
    expect(phoneEntities('call 9876543210 now')).toHaveLength(1);
    const r = await sanitize('call 9876543210 now');
    expect(r.aliases).toContain('USER_PHONE_1');
    expect(r.text).not.toContain('9876543210');
  });
  it('Format 2 — 5+5 space/hyphen/dot', async () => {
    expect(phoneEntities('98765 43210')).toHaveLength(1);
    expect(phoneEntities('98765-43210')).toHaveLength(1);
    expect(phoneEntities('98765.43210')).toHaveLength(1);
  });
  it('Format 3 — 3+4+3', async () => {
    expect(phoneEntities('987-6543-210')).toHaveLength(1);
    expect(phoneEntities('987 6543 210')).toHaveLength(1);
  });
  it('Format 4 — +91 variants', async () => {
    expect(phoneEntities('+91 9876543210')).toHaveLength(1);
    expect(phoneEntities('+91-9876543210')).toHaveLength(1);
    expect(phoneEntities('+91 98765 43210')).toHaveLength(1);
    expect(phoneEntities('+9198765 43210')).toHaveLength(1);
  });
  it('Format 5 — 0 prefix', async () => {
    expect(phoneEntities('09876543210')).toHaveLength(1);
    expect(phoneEntities('098765 43210')).toHaveLength(1);
  });
  it('Format 6 — 0091', async () => {
    expect(phoneEntities('0091 9876543210')).toHaveLength(1);
    expect(phoneEntities('009198765 43210')).toHaveLength(1);
  });
  it('Two numbers → USER_PHONE_1 + USER_PHONE_2', async () => {
    const r = await sanitize('first 9876543210 second 8765432109');
    expect(r.aliases).toContain('USER_PHONE_1');
    expect(r.aliases).toContain('USER_PHONE_2');
  });
  it('Must NOT detect short or invalid', () => {
    expect(phoneEntities('12345')).toHaveLength(0);
    expect(phoneEntities('1234567890')).toHaveLength(0); // starts with 1
    expect(phoneEntities('2345 6789 0123')).toHaveLength(0); // Aadhaar
  });
  it('Phone in context still detected (fail-closed)', async () => {
    expect(phoneEntities('order #9876543210')).toHaveLength(1);
    expect(phoneEntities('page 1 of 9876543210')).toHaveLength(1);
  });
});
