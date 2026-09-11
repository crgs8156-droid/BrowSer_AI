// PIV canary test — runs before every other PIV test.
// The PIV module must have ZERO telemetry/audit/console/network imports:
// values live in chrome.storage.local only and must never reach logs.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAuditLog, resetAuditForTests } from '../../../extension/src/audit/log';
import { addEntry } from '../../../extension/src/piv/store';

const CANARY_EMAIL = 'CANARY_PIV_001@example.test';
const CANARY_PHONE = '9876543210';

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
  return mem;
}

describe('PIV zero-leakage canary', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetAuditForTests();
  });

  it('piv sources import no telemetry, audit, console, or network', () => {
    const dir = join(process.cwd(), 'extension', 'src', 'piv');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(0);
    const forbidden =
      /telemetry|audit\/log|logAuditEvent|recordEvent|sessionTelemetry|ocrTrace|console\.|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/;
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, `${file} must not touch telemetry/audit/console/network`).not.toMatch(forbidden);
    }
  });

  it('storing canaries leaves the audit log empty', async () => {
    stubLocalStorage();
    resetAuditForTests();
    const saved = await addEntry({
      category: 'contact',
      label: 'Personal Email',
      value: CANARY_EMAIL,
      aliasHint: 'USER_EMAIL_1',
    });
    expect(saved.ok).toBe(true);
    const savedPhone = await addEntry({
      category: 'contact',
      label: 'Mobile Number',
      value: CANARY_PHONE,
      aliasHint: 'USER_PHONE_1',
    });
    expect(savedPhone.ok).toBe(true);
    const audit = await getAuditLog();
    expect(audit).toHaveLength(0);
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain(CANARY_EMAIL);
    expect(auditJson).not.toContain(CANARY_PHONE);
  });
});
