import { describe, expect, it } from 'vitest';
import { decidePolicyReport } from '../../../extension/src/policy';
import {
  isNavigationOnlyTask,
  taskInvolvesCredentials,
  taskInvolvesPayment,
} from '../../../extension/src/agent/services';
import type { PolicySignals, SensitiveEntity } from '../../../extension/src/types/contracts';

function credentialEntity(): SensitiveEntity {
  // Critical + confirmed (0.9 >= 0.85): BLOCK baseline without a task.
  // No `text` field — the policy never reads values (Rule 4).
  return {
    id: 'cred-1',
    category: 'CREDENTIAL',
    source: 'DOM',
    confidence: 0.9,
    reasons: ['label evidence'],
  } as unknown as SensitiveEntity;
}

function authSignals(): PolicySignals {
  return {
    entities: [credentialEntity()],
    visualContext: { pageType: 'auth', confidence: 0.95 },
    restricted: false,
  };
}

function paymentSignals(): PolicySignals {
  // Critical credential confirmed on a payment-classified page: BLOCK baseline.
  return {
    entities: [{ ...credentialEntity(), id: 'pay-1' } as unknown as SensitiveEntity],
    visualContext: { pageType: 'payment', confidence: 0.95 },
    restricted: false,
  };
}

describe('navigation-only tasks are never page-blocked', () => {
  it('"open youtube" on auth page → SANITIZE not BLOCK', () => {
    expect(decidePolicyReport(authSignals()).overall.action).toBe('BLOCK');
    const report = decidePolicyReport(authSignals(), 'open youtube');
    expect(report.overall.action).toBe('SANITIZE');
    expect(report.overall.signals).toContain('navigation_task');
  });

  it('"open gmail" on payment page → SANITIZE not BLOCK', () => {
    const report = decidePolicyReport(paymentSignals(), 'open gmail');
    expect(report.overall.action).toBe('SANITIZE');
    expect(report.overall.signals).toContain('navigation_task');
  });

  it('"login with my email" on auth page → BLOCK preserved (credential task)', () => {
    const report = decidePolicyReport(authSignals(), 'login with my email');
    expect(report.overall.action).toBe('BLOCK');
    expect(report.overall.signals).not.toContain('navigation_task');
  });

  it('"pay with my card" on payment page → BLOCK preserved (payment task)', () => {
    const report = decidePolicyReport(paymentSignals(), 'pay with my card');
    expect(report.overall.action).toBe('BLOCK');
  });

  it('omitted task keeps legacy behavior exactly', () => {
    const without = decidePolicyReport(authSignals());
    expect(without.overall.action).toBe('BLOCK');
    expect(without.overall.signals).not.toContain('navigation_task');
  });
});

describe('isNavigationOnlyTask', () => {
  it('"open youtube" → true', () => {
    expect(isNavigationOnlyTask('open youtube')).toBe(true);
  });

  it('"fill my email" → false', () => {
    expect(isNavigationOnlyTask('fill my email')).toBe(false);
  });

  it('"go to github" → true', () => {
    expect(isNavigationOnlyTask('go to github')).toBe(true);
  });

  it('"login to gmail" → false', () => {
    expect(isNavigationOnlyTask('login to gmail')).toBe(false);
  });

  it('taskInvolvesCredentials / taskInvolvesPayment predicates', () => {
    expect(taskInvolvesCredentials('login with my email')).toBe(true);
    expect(taskInvolvesCredentials('open youtube')).toBe(false);
    expect(taskInvolvesPayment('pay with my card')).toBe(true);
    expect(taskInvolvesPayment('open youtube')).toBe(false);
  });
});
