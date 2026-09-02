import type { AliasRecord } from '../types/contracts';

// Local identity vault (blueprint §6/§7). Stores alias↔value mappings ON-DEVICE
// ONLY, in memory — never in chrome.storage, localStorage, IndexedDB, a file, a
// log, or any remote payload (CONTRIBUTING.md §5 Rule 3/4). The mapping is the most
// sensitive artefact in the system: it is the one place a raw value sits beside
// its alias, so it lives only for the lifetime of the extension context and is
// wiped per session by `clearSession`.
//
// Persisting the vault at rest is deliberately NOT done here (see threat-model
// R15): an unencrypted store would violate Rule 4. If persistence is ever added
// it must be encrypted and session-scoped; until then the mapping is volatile.

export interface LocalVault {
  put(record: AliasRecord, actualValue: string): Promise<void>;
  resolve(alias: string): Promise<string | undefined>;
  clearSession(sessionId: string): Promise<void>;
}

interface VaultEntry {
  value: string;
  category: AliasRecord['category'];
  sessionId: string;
  createdAt: number;
}

export function createLocalVault(): LocalVault {
  // In-memory only. Not persisted; garbage-collected with the context.
  const store = new Map<string, VaultEntry>();

  return {
    async put(record, actualValue) {
      if (!record || typeof record.alias !== 'string' || record.alias.length === 0) {
        throw new Error('PrivAgent: vault.put requires a non-empty alias.');
      }
      if (typeof actualValue !== 'string' || actualValue.length === 0) {
        throw new Error('PrivAgent: vault.put requires a non-empty value.');
      }
      store.set(record.alias, {
        value: actualValue,
        category: record.category,
        sessionId: record.sessionId,
        createdAt: record.createdAt,
      });
    },

    async resolve(alias) {
      return store.get(alias)?.value;
    },

    async clearSession(sessionId) {
      for (const [alias, entry] of store) {
        if (entry.sessionId === sessionId) store.delete(alias);
      }
    },
  };
}
