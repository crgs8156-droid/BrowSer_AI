// M5 — LocalVault unit tests. In-memory alias↔value store only.
// Synthetic canaries only (CLAUDE.md §13/§15).

import { describe, expect, it } from 'vitest';
import { createLocalVault } from '../../extension/src/vault';
import type { AliasRecord } from '../../extension/src/types/contracts';

const CANARY = 'CANARY_vault_v4lue+9f2a@example.test';

function rec(overrides: Partial<AliasRecord> = {}): AliasRecord {
  return { alias: 'USER_EMAIL_1', category: 'EMAIL', sessionId: 's1', createdAt: 1000, ...overrides };
}

describe('LocalVault — in-memory alias↔value store', () => {
  it('stores and resolves a value by alias', async () => {
    const v = createLocalVault();
    await v.put(rec(), CANARY);
    expect(await v.resolve('USER_EMAIL_1')).toBe(CANARY);
  });

  it('returns undefined for an unknown alias', async () => {
    const v = createLocalVault();
    expect(await v.resolve('USER_EMAIL_999')).toBeUndefined();
  });

  it('rejects an empty alias or empty value (fail closed)', async () => {
    const v = createLocalVault();
    await expect(v.put(rec({ alias: '' }), CANARY)).rejects.toThrow();
    await expect(v.put(rec(), '')).rejects.toThrow();
  });

  it('clearSession removes only the named session, leaving others intact', async () => {
    const v = createLocalVault();
    await v.put(rec({ alias: 'USER_EMAIL_1', sessionId: 's1' }), CANARY);
    await v.put(rec({ alias: 'USER_PHONE_1', category: 'PHONE', sessionId: 's2' }), '555-0100');
    await v.clearSession('s1');
    expect(await v.resolve('USER_EMAIL_1')).toBeUndefined();
    expect(await v.resolve('USER_PHONE_1')).toBe('555-0100');
  });

  it('the latest put for an alias wins', async () => {
    const v = createLocalVault();
    await v.put(rec(), 'first@corp.test');
    await v.put(rec(), 'second@corp.test');
    expect(await v.resolve('USER_EMAIL_1')).toBe('second@corp.test');
  });
});
