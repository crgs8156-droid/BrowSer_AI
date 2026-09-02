import type { AgentActionKind } from '../types/contracts';

// The exhaustive allowlist of constrained agent actions (blueprint §8, CONTRIBUTING.md §7).
// `satisfies` keeps this in lockstep with the AgentAction union in types/contracts.ts.
export const ALLOWED_ACTION_KINDS = [
  'CLICK',
  'TYPE',
  'SELECT',
  'SCROLL',
  'NAVIGATE',
] as const satisfies readonly AgentActionKind[];
