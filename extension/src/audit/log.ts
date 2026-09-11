// Phase 3 — session audit log (sidepanel/loop observability).
//
// Value-free BY CONSTRUCTION (CONTRIBUTING.md Rule 4): callers pass only
// category names, aliases, origins, and counts — never raw values, never
// alias-to-value mappings, never free-form selectors that could embed PII.
// Session-scoped: `chrome.storage.session` (wiped when the browser closes),
// in-memory mirror as source of truth, max 100 entries FIFO.

export type AuditEventType =
  | 'pii_detected'
  | 'alias_created'
  | 'action_executed'
  | 'navigation'
  | 'vault_wiped'
  | 'firewall_blocked'
  | 'captcha_detected'
  | 'task_complete'
  | 'task_failed';

export interface AuditEntry {
  timestamp: number;
  sessionId: string;
  type: AuditEventType;
  /** Human readable, NO raw values (enforced by caller contract + canary tests). */
  detail: string;
  stepNumber?: number;
  bytesBlocked?: number;
}

export const AUDIT_STORAGE_KEY = 'auditLog';
export const MAX_AUDIT_ENTRIES = 100;

export const AUDIT_ICONS: Record<AuditEventType, string> = {
  pii_detected: '\u{1F6E1}\uFE0F',
  alias_created: '\u{1F511}',
  action_executed: '\u2705',
  navigation: '\u{1F310}',
  vault_wiped: '\u{1F5D1}\uFE0F',
  firewall_blocked: '\u{1F6AB}',
  captcha_detected: '\u26A0\uFE0F',
  task_complete: '\u2705',
  task_failed: '\u274C',
};

let memory: AuditEntry[] = [];
let hydrated = false;

function persistBestEffort(): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      void chrome.storage.session.set({ [AUDIT_STORAGE_KEY]: memory });
    }
  } catch {
    // ignore - audit persistence is best-effort
  }
}

/** Append an entry (sync; persistence is best-effort fire-and-forget). */
export function logAuditEvent(entry: Omit<AuditEntry, 'timestamp'>): void {
  memory.push({ ...entry, timestamp: Date.now() });
  while (memory.length > MAX_AUDIT_ENTRIES) memory.shift();
  persistBestEffort();
}

/** Current session entries (oldest first). Hydrates from session storage once. */
export async function getAuditLog(): Promise<AuditEntry[]> {
  if (!hydrated) {
    hydrated = true;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        const data = await chrome.storage.session.get(AUDIT_STORAGE_KEY);
        const stored = (data as Record<string, unknown>)[AUDIT_STORAGE_KEY];
        if (Array.isArray(stored)) {
          memory = (stored as AuditEntry[]).filter(
            (e) => e && typeof e.timestamp === 'number' && typeof e.detail === 'string',
          ).slice(-MAX_AUDIT_ENTRIES);
        }
      }
    } catch {
      // ignore - fall back to in-memory
    }
  }
  return memory.slice();
}

/** Empty the log (called alongside vault.clearSession — fresh session, fresh log). */
export function clearAuditLog(): void {
  memory = [];
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      void chrome.storage.session.remove(AUDIT_STORAGE_KEY);
    }
  } catch {
    // ignore - clearing is best-effort
  }
}

/** Test hook: reset module state between unit tests. */
export function resetAuditForTests(): void {
  memory = [];
  hydrated = true;
}

/** HH:MM:SS for panel display. */
export function formatAuditTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Serialize entries for Export JSON (schema-conformant, value-free). */
export function serializeAuditLog(entries: AuditEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

/** Download filename for the audit export. */
export function auditExportFilename(now: Date = new Date()): string {
  return `privagent-audit-${now.toISOString().slice(0, 10)}.json`;
}
