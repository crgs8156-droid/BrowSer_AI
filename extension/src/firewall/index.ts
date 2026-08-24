import type { RemoteAgentRequest } from '../types/contracts';

// Privacy firewall (blueprint §7, CLAUDE.md §5): the single outbound boundary.
// Every remote request passes through inspect(). If safety cannot be established → FAIL CLOSED.
// Implemented in M7.
export interface FirewallVerdict {
  allowed: boolean;
  reason: string;
}

export interface PrivacyFirewall {
  inspect(_request: RemoteAgentRequest): Promise<FirewallVerdict>;
}

export function createPrivacyFirewall(): PrivacyFirewall {
  return {
    inspect() {
      throw new Error('PrivAgent: PrivacyFirewall.inspect not implemented (M7).');
    },
  };
}
