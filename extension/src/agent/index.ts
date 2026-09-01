// M6 — agent module public surface.
//
// `AgentGateway` is the provider-agnostic planner interface (blueprint §8). Two
// implementations ship in M6:
//   - `createDeterministicPlanner` — pure, offline, reproducible (the blueprint's
//     recommended first planner);
//   - `createRemoteHttpAgentGateway` — posts through the privacy firewall to the
//     FastAPI backend (`POST /v1/plan`); the LLM/Ollama provider itself lands in S4.

import type { AgentAction, RemoteAgentRequest } from '../types/contracts';

export interface AgentGateway {
  plan(request: RemoteAgentRequest): Promise<AgentAction[]>;
}

export { createDeterministicPlanner, planDeterministic } from './planner';
export {
  createRemoteHttpAgentGateway,
  FirewallBlockedError,
  type RemoteHttpAgentGatewayOptions,
} from './remote';
export {
  runAgentLoop,
  toSanitizedNodes,
  type AgentLoopOptions,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentStepRecord,
} from './loop';
