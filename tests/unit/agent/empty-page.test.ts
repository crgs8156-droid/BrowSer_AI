import { describe, expect, it } from 'vitest';
import { createPrivacyFirewall } from '../../../extension/src/firewall';
import { planDeterministic } from '../../../extension/src/agent/planner';
import type { RemoteAgentRequest } from '../../../extension/src/types/contracts';

/** The exact request shape loop.ts builds for a page with zero DOM nodes. */
function emptyPageRequest(overrides: Partial<RemoteAgentRequest> = {}): RemoteAgentRequest {
  return {
    taskObjective: 'open gmail',
    pageOrigin: 'https://privagent.test',
    sanitizedPageStructure: [],
    sanitizedVisibleText: '',
    aliases: [],
    availableActions: ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'NAVIGATE'],
    policy: { privacyMode: 'strict', navigationAllowlist: ['https://mail.google.com'] },
    ...overrides,
  };
}

describe('empty page navigation', () => {
  it('empty perception builds a firewall-valid PlanRequest', async () => {
    const verdict = await createPrivacyFirewall().inspect(emptyPageRequest());
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });

  it('bare "open gmail" + allowlisted gmail → NAVIGATE to the allowlist entry', () => {
    expect(planDeterministic(emptyPageRequest())).toEqual([
      { action: 'NAVIGATE', url: 'https://mail.google.com' },
    ]);
  });

  it('never invents a URL when gmail is not allowlisted', () => {
    const actions = planDeterministic(
      emptyPageRequest({ policy: { privacyMode: 'strict', navigationAllowlist: [] } }),
    );
    expect(actions).toEqual([]);
  });

  it('skips navigation when already on the target origin', () => {
    const actions = planDeterministic(
      emptyPageRequest({ pageOrigin: 'https://mail.google.com' }),
    );
    expect(actions).toEqual([]);
  });
});
