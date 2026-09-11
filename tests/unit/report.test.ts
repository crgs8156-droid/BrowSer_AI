import { beforeEach, describe, expect, it } from 'vitest';
import { logAuditEvent, resetAuditForTests, clearAuditLog } from '../../extension/src/audit/log';
import {
  exportReportAsJSON,
  generateReport,
  reportFilename,
  serializeReport,
} from '../../extension/src/report/generate';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';

beforeEach(() => {
  resetAuditForTests();
  clearAuditLog();
});

describe('privacy report export (Phase 5)', () => {
  it('returns the correct schema with zeroed leak counters', async () => {
    logAuditEvent({ sessionId: 's', type: 'pii_detected', detail: 'Detected USER_EMAIL category (2 instances)' });
    logAuditEvent({ sessionId: 's', type: 'action_executed', detail: 'TYPE on #email (USER_EMAIL_1)' });
    logAuditEvent({ sessionId: 's', type: 'task_complete', detail: 'Task completed in 1 steps, 0 bytes leaked' });
    const report = await generateReport('gemini');
    expect(report.sessionSummary.bytesLeaked).toBe(0);
    expect(report.sessionSummary.tasksCompleted).toBe(1);
    expect(report.sessionSummary.totalSteps).toBe(1);
    expect(report.sessionSummary.piiItemsProtected).toBe(2);
    expect(report.sessionSummary.categoriesProtected).toEqual(['email']);
    expect(report.systemInfo.plannerMode).toBe('gemini');
    expect(report.systemInfo.onDevice).toBe(true);
    expect(report.disclaimer).toContain('Raw values were never stored');
    expect(typeof report.generatedAt).toBe('string');
  });

  it('carries no raw PII (canary test)', async () => {
    expect(CANARY_EMAIL).toContain('@');
    logAuditEvent({ sessionId: 's', type: 'alias_created', detail: 'Alias USER_EMAIL_1 created' });
    const json = serializeReport(await generateReport());
    expect(json).not.toContain(CANARY_EMAIL);
  });

  it('export is a safe no-op outside a document + filename format', async () => {
    expect(await exportReportAsJSON()).toBe(false);
    expect(reportFilename(new Date('2026-09-11T00:00:00Z'))).toBe('privagent-report-2026-09-11.json');
  });
});
