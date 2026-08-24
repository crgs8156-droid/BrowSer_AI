import type { SensitiveEntity } from '../types/contracts';

// Multi-signal sensitivity engine (blueprint §5/§6): rules + context + model confidence.
// Rule-based detection lands in M2; fused/model scoring in M4.
export interface SensitivityEngine {
  analyze(_candidates: unknown): Promise<SensitiveEntity[]>;
}

export function createSensitivityEngine(): SensitivityEngine {
  return {
    analyze() {
      throw new Error('PrivAgent: SensitivityEngine.analyze not implemented (M2/M4).');
    },
  };
}
