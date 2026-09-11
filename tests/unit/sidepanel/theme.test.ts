import { describe, expect, it } from 'vitest';
import {
  getRunStateVersion,
  isAgentRunning,
  setAgentRunning,
  subscribeToRunState,
} from '../../../extension/src/sidepanel/run-state';
import { aliasesFromAudit } from '../../../extension/src/sidepanel/VaultPanel';
import type { AuditEntry } from '../../../extension/src/audit/log';

function entry(partial: Partial<AuditEntry> & { type: AuditEntry['type'] }): AuditEntry {
  return { timestamp: 1, sessionId: 's', detail: '', ...partial };
}

describe('run-state fan-out', () => {
  it('toggles running and notifies subscribers', () => {
    setAgentRunning(false);
    let calls = 0;
    const unsub = subscribeToRunState(() => {
      calls++;
    });
    const before = getRunStateVersion();
    setAgentRunning(true);
    expect(isAgentRunning()).toBe(true);
    expect(getRunStateVersion()).toBeGreaterThan(before);
    expect(calls).toBe(1);
    setAgentRunning(true);
    expect(calls).toBe(1);
    unsub();
    setAgentRunning(false);
    expect(isAgentRunning()).toBe(false);
  });
});

describe('aliasesFromAudit', () => {
  it('lists distinct aliases in first-seen order with categories', () => {
    const rows = aliasesFromAudit([
      entry({ type: 'alias_created', detail: 'Alias USER_EMAIL_1 created' }),
      entry({ type: 'action_executed', detail: 'TYPE on #email (USER_EMAIL_1)' }),
      entry({ type: 'alias_created', detail: 'Alias USER_PHONE_1 created' }),
      entry({ type: 'alias_created', detail: 'Alias USER_EMAIL_1 created' }),
    ]);
    expect(rows).toEqual([
      { alias: 'USER_EMAIL_1', category: 'EMAIL' },
      { alias: 'USER_PHONE_1', category: 'PHONE' },
    ]);
  });

  it('skips non-alias entries and never carries values', () => {
    const rows = aliasesFromAudit([
      entry({ type: 'task_complete', detail: 'Task completed in 2 steps, 0 bytes leaked' }),
    ]);
    expect(rows).toEqual([]);
  });
});
