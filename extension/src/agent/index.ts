import type { AgentAction, RemoteAgentRequest } from '../types/contracts';

// Agent gateway (blueprint §8). Provider-agnostic: the first implementation is a
// deterministic JSON action planner (no LLM provider chosen — see docs/interface-contracts.md §2).
// Implemented in M6.
export interface AgentGateway {
  plan(_request: RemoteAgentRequest): Promise<AgentAction[]>;
}

export function createAgentGateway(): AgentGateway {
  return {
    plan() {
      throw new Error('PrivAgent: AgentGateway.plan not implemented (M6).');
    },
  };
}
