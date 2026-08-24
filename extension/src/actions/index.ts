import type { AgentAction } from '../types/contracts';

// Structured action validator + local action bridge (blueprint §7/§9, CLAUDE.md §7).
// Pipeline: schema validation → policy validation → LOCAL alias resolution → execute.
// No arbitrary JS is ever executed. Implemented in M6.
export interface ValidationResult {
  valid: boolean;
  reason: string;
}

export interface ActionBridge {
  validate(_action: AgentAction): ValidationResult;
  execute(_action: AgentAction): Promise<void>;
}

export function createActionBridge(): ActionBridge {
  return {
    validate() {
      throw new Error('PrivAgent: ActionBridge.validate not implemented (M6).');
    },
    execute() {
      throw new Error('PrivAgent: ActionBridge.execute not implemented (M6).');
    },
  };
}
