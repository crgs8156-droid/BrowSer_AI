import { describe, expect, it } from 'vitest';
import { decidePolicy, decidePolicyReport } from '../../../../extension/src/policy';
import type { PolicySignals } from '../../../../extension/src/types/contracts';

function signals(partial: Partial<PolicySignals>): PolicySignals {
  return { entities: [], restricted: false, ...partial };
}

describe('M7.5 — page-type gate in the policy layer', () => {
  it('forces SANITIZE for a payment page even with no other signals', () => {
    const report = decidePolicyReport(
      signals({ visualContext: { pageType: 'payment', confidence: 0.95 } }),
    );
    expect(report.overall.action).toBe('SANITIZE');
    expect(report.overall.signals).toContain('visual_high_risk');
    expect(report.overall.explanation).toContain('payment');
    expect(report.visualContext).toEqual({ pageType: 'payment', confidence: 0.95 });
  });

  it('forces SANITIZE for an auth page', () => {
    const decision = decidePolicy(
      signals({ visualContext: { pageType: 'auth', confidence: 0.95 } }),
    );
    expect(decision.action).toBe('SANITIZE');
    expect(decision.signals).toContain('visual_high_risk');
  });

  it('never downgrades a BLOCK on a high-risk page (fail closed)', () => {
    const report = decidePolicyReport(
      signals({
        visualContext: { pageType: 'payment', confidence: 0.95 },
        entities: [
          {
            id: 'cred-1',
            category: 'PASSWORD',
            source: 'DOM',
            text: 'password: hunter2hunter2',
            confidence: 1,
            reasons: ['test'],
          },
        ],
      }),
    );
    expect(report.overall.action).toBe('BLOCK');
    expect(report.overall.signals).toContain('visual_high_risk');
  });

  it('leaves normal signal flow untouched for a general page', () => {
    const report = decidePolicyReport(
      signals({ visualContext: { pageType: 'general', confidence: 0.6 } }),
    );
    expect(report.overall.action).toBe('ALLOW');
    expect(report.overall.signals).not.toContain('visual_high_risk');
    expect(report.visualContext).toEqual({ pageType: 'general', confidence: 0.6 });
  });
});
