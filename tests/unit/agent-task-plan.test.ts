import { describe, expect, it } from 'vitest';
import { toTaskPlan } from '../../extension/src/agent/remote';

describe('toTaskPlan adapter (Part A, backward-compat)', () => {
  it('maps empty actions to complete+done', () => {
    const plan = toTaskPlan([]);
    expect(plan.type).toBe('complete');
    expect(plan.done).toBe(true);
    expect(plan.summary).toContain('0 bytes leaked');
  });

  it('maps a navigate action to navigate with origin-only url', () => {
    const plan = toTaskPlan([{ action: 'NAVIGATE', url: 'https://site.test/form?x=1' }]);
    expect(plan.type).toBe('navigate');
    expect(plan.done).toBe(false);
    expect(plan.url).toBe('https://site.test');
  });

  it('maps regular actions to action+not-done without leaking values', () => {
    const plan = toTaskPlan([{ action: 'TYPE', target: '#email', value: 'USER_EMAIL_1' }]);
    expect(plan.type).toBe('action');
    expect(plan.done).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('user@example.test');
  });
});
