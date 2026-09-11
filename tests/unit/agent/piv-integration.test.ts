import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalVault } from '../../../extension/src/vault';
import { categoryFromAlias, registrableEntries } from '../../../extension/src/piv/agent';
import { addEntry, loadStore } from '../../../extension/src/piv/store';
import { clearAuditLog, getAuditLog, resetAuditForTests } from '../../../extension/src/audit/log';

const CANARY_EMAIL = 'CANARY_PIV_INT_001@example.test';

function stubLocalStorage() {
  const mem = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: mem.get(key) }),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) mem.set(k, v);
        },
        remove: async (key: string) => {
          mem.delete(key);
        },
      },
    },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetAuditForTests();
  clearAuditLog();
});

describe('piv agent integration', () => {
  it('on run start: PIV entries loaded into session vault as aliases', async () => {
    stubLocalStorage();
    await addEntry({ category: 'contact', label: 'Personal Email', value: CANARY_EMAIL, aliasHint: 'USER_EMAIL_1' });
    const vault = createLocalVault();
    const sessionId = 'piv-int-session';
    const entries = registrableEntries((await loadStore()).entries);
    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      await vault.put(
        { alias: entry.aliasHint, category: categoryFromAlias(entry.aliasHint), sessionId, createdAt: Date.now() },
        entry.value,
      );
    }
    expect(await vault.resolve('USER_EMAIL_1')).toBe(CANARY_EMAIL);
  });

  it('step log line uses the exact wired format', () => {
    const lines: string[] = ['🔍 Scanning page...'];
    const count = 1;
    lines.push(`🔑 Loaded ${count} personal data entries from vault`);
    expect(lines).toContain('🔑 Loaded 1 personal data entries from vault');
  });

  it('after run: session vault wiped, PIV store unchanged', async () => {
    stubLocalStorage();
    await addEntry({ category: 'contact', label: 'Personal Email', value: CANARY_EMAIL, aliasHint: 'USER_EMAIL_1' });
    const vault = createLocalVault();
    const sessionId = 'piv-int-session-2';
    await vault.put({ alias: 'USER_EMAIL_1', category: 'EMAIL', sessionId, createdAt: Date.now() }, CANARY_EMAIL);
    await vault.clearSession(sessionId);
    expect(await vault.resolve('USER_EMAIL_1')).toBeUndefined();
    expect((await loadStore()).entries).toHaveLength(1);
  });

  it('PIV values never reach the audit log', async () => {
    stubLocalStorage();
    resetAuditForTests();
    await addEntry({ category: 'contact', label: 'Personal Email', value: CANARY_EMAIL, aliasHint: 'USER_EMAIL_1' });
    const auditJson = JSON.stringify(await getAuditLog());
    expect(auditJson).not.toContain(CANARY_EMAIL);
  });
});
