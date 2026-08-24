import type { PrivacyEvent } from '../types/contracts';

// Telemetry / audit log (blueprint §4, CLAUDE.md §5). Records privacy EVENTS only.
// MUST NOT persist raw protected values. Implemented in M7.
export interface Telemetry {
  record(_event: PrivacyEvent): void;
}

export function createTelemetry(): Telemetry {
  return {
    record() {
      throw new Error('PrivAgent: Telemetry.record not implemented (M7).');
    },
  };
}
