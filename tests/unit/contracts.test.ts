import { describe, expect, it } from 'vitest';
import { ALLOWED_ACTION_KINDS } from '../../extension/src/actions/kinds';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';

// M0 scaffolding sanity checks. These assert the SHAPE of the contracts and that
// unimplemented modules fail loudly — they do NOT exercise any privacy feature logic.

describe('action allowlist', () => {
  it('is exactly the five constrained actions', () => {
    expect([...ALLOWED_ACTION_KINDS].sort()).toEqual([
      'CLICK',
      'NAVIGATE',
      'SCROLL',
      'SELECT',
      'TYPE',
    ]);
  });
});

describe('privacy firewall stub', () => {
  it('is not silently implemented — the guard throws until M7', () => {
    const firewall = createPrivacyFirewall();
    const request: RemoteAgentRequest = {
      taskObjective: 'noop',
      sanitizedPageStructure: [],
      sanitizedVisibleText: '',
      aliases: [],
      availableActions: [...ALLOWED_ACTION_KINDS],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
    };
    expect(() => firewall.inspect(request)).toThrow(/not implemented/);
  });
});
