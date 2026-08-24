import type { AliasRecord } from '../types/contracts';

// Local identity vault (blueprint §6/§7). Stores alias↔value mappings ON-DEVICE ONLY.
// The mapping MUST NEVER be serialized to a remote payload, log, or export. Implemented in M5.
export interface LocalVault {
  put(_record: AliasRecord, _actualValue: string): Promise<void>;
  resolve(_alias: string): Promise<string | undefined>;
  clearSession(_sessionId: string): Promise<void>;
}

export function createLocalVault(): LocalVault {
  return {
    put() {
      throw new Error('PrivAgent: LocalVault.put not implemented (M5).');
    },
    resolve() {
      throw new Error('PrivAgent: LocalVault.resolve not implemented (M5).');
    },
    clearSession() {
      throw new Error('PrivAgent: LocalVault.clearSession not implemented (M5).');
    },
  };
}
