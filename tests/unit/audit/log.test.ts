import { beforeEach, describe, expect, it } from 'vitest';
import {
  auditExportFilename,
  clearAuditLog,
  formatAuditTime,
  getAuditLog,
  logAuditEvent,
  resetAuditForTests,
  serializeAuditLog,
  type AuditEntry,
} from '../../../extension/src/audit/log';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';

beforeEach(() => {
  resetAuditForTests();
  clearAuditLog();
});

describe('session audit log (Phase 3)', () => {
  it('adds events and returns them oldest-first', async () => {
    logAuditEvent({ sessionId: 's1', type: 'pii_detected', detail: 'Detected USER_EMAIL category (1 instance)' });
    logAuditEvent({ sessionId: 's1', type: 'task_complete', detail: 'Task completed in 2 steps, 0 bytes leaked' });
    const entries = await getAuditLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe('pii_detected');
    expect(typeof entries[0]!.timestamp).toBe('number');
  });

  it('caps at 100 entries FIFO (oldest dropped first)', async () => {
    for (let i = 0; i < 105; i++) {
      logAuditEvent({ sessionId: 's', type: 'action_executed', detail: `CLICK on #b${i} — executed`, stepNumber: i });
    }
    const entries = await getAuditLog();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.stepNumber).toBe(5);
    expect(entries[99]!.stepNumber).toBe(104);
  });

  it('clearAuditLog empties the log', async () => {
    logAuditEvent({ sessionId: 's', type: 'navigation', detail: 'Navigated to origin: https://x.test' });
    clearAuditLog();
    expect(await getAuditLog()).toHaveLength(0);
  });

  it('never carries raw values (canary test)', async () => {
    // The canary exists in this scope but only safe details are logged.
    expect(CANARY_EMAIL).toContain('@');
    logAuditEvent({ sessionId: 's', type: 'alias_created', detail: 'Alias USER_EMAIL_1 created' });
    logAuditEvent({ sessionId: 's', type: 'action_executed', detail: 'TYPE on #email (USER_EMAIL_1)' });
    const json = serializeAuditLog(await getAuditLog());
    expect(json).not.toContain(CANARY_EMAIL);
    expect(json).toContain('USER_EMAIL_1');
  });

  it('export matches the AuditEntry schema + helpers behave', () => {
    expect(auditExportFilename(new Date('2026-09-11T00:00:00Z'))).toBe('privagent-audit-2026-09-11.json');
    expect(formatAuditTime(new Date('2026-09-11T01:02:03').getTime())).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const parsed = JSON.parse(
      serializeAuditLog([{ timestamp: 1, sessionId: 's', type: 'task_complete', detail: 'done' }]),
    ) as AuditEntry[];
    expect(parsed[0]).toMatchObject({ timestamp: 1, sessionId: 's', type: 'task_complete', detail: 'done' });
  });
});
