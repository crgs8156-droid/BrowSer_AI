import { describe, expect, it } from 'vitest';
import { clearLastCloudPayload, createRemoteHttpAgentGateway, getLastCloudPayload, getLastCloudPayloadMeta } from '../../extension/src/agent/remote';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';

function req(): RemoteAgentRequest {
  return {
    taskObjective: 'fill',
    sanitizedPageStructure: [{ tag: 'input', selector: '#a', filled: false, disabled: false }],
    sanitizedVisibleText: 'hello',
    aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
    availableActions: ['CLICK'],
    policy: { privacyMode: 'strict', navigationAllowlist: [] },
  };
}

describe('cloud payload viewer (curated summary)', () => {
  it('captures sanitized payload after firewall allow (deep copy)', async () => {
    clearLastCloudPayload();
    expect(getLastCloudPayload()).toBeNull();
    const gw = createRemoteHttpAgentGateway({
      endpoint: 'https://x.test/plan',
      firewall: createPrivacyFirewall(),
      fetchImpl: (async () => new Response(JSON.stringify({ actions: [] }), { status: 200 })) as unknown as typeof fetch,
    });
    await gw.plan(req());
    const snap = getLastCloudPayload();
    expect(snap?.aliases[0]?.alias).toBe('USER_EMAIL_1');
    expect(JSON.stringify(snap)).not.toContain('user@example.test');
    expect(getLastCloudPayloadMeta()?.bytes).toBeGreaterThan(0);
    // deep copy: mutating snap does not affect stored
    if (snap) snap.taskObjective = 'mutated';
    expect(getLastCloudPayload()?.taskObjective).toBe('fill');
  });
  it('offline mode leaves no payload (viewer shows offline)', () => {
    clearLastCloudPayload();
    expect(getLastCloudPayload()).toBeNull();
  });
});
