// Personal Identity Vault — persistent user-managed store (PIV).
//
// SEPARATE from the session vault (`../vault`, in-memory, per-run): PIV is
// persistent, user-managed, and lives in `chrome.storage.local`.
//
// SECURITY NOTES (deliberate, disclosed simplification — AES-GCM deferred):
// 1. Values are stored UNENCRYPTED in chrome.storage.local. Chrome profile
//    isolation provides basic protection. The UI carries a clear notice.
// 2. Values are NEVER sent anywhere. They are copied into the in-memory
//    session vault at run start only; the session vault is wiped after.
// 3. Clearing Chrome storage wipes PIV — export backup is recommended.
// 4. This module imports NOTHING that can leak: no event emitters, no log
//    writers, no console output, no network calls. Enforced by
//    tests/unit/piv/canary.test.ts.

export type PIVCategory =
  | 'personal'
  | 'contact'
  | 'identity'
  | 'financial'
  | 'professional'
  | 'custom';

export interface PIVEntry {
  id: string;
  category: PIVCategory;
  label: string;
  value: string;
  aliasHint: string;
  createdAt: number;
  lastUsed: number;
}

export interface PIVStore {
  version: 1;
  entries: PIVEntry[];
  lastModified: number;
}

export const PIV_STORAGE_KEY = 'piv_store';
export const PIV_VERSION = 1;

const ALIAS_HINT_PATTERN = /^USER_[A-Z]+_\d+$/;
const PIV_CATEGORIES: ReadonlySet<string> = new Set([
  'personal',
  'contact',
  'identity',
  'financial',
  'professional',
  'custom',
]);

function localArea(): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  } catch {
    // ignore — storage unavailable in this context
  }
  return null;
}

export function emptyStore(): PIVStore {
  return { version: PIV_VERSION, entries: [], lastModified: Date.now() };
}

function isValidEntry(value: unknown): value is PIVEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    (e['id'] as string).length > 0 &&
    typeof e['category'] === 'string' &&
    PIV_CATEGORIES.has(e['category'] as string) &&
    typeof e['label'] === 'string' &&
    (e['label'] as string).length > 0 &&
    typeof e['value'] === 'string' &&
    (e['value'] as string).length > 0 &&
    typeof e['aliasHint'] === 'string' &&
    ALIAS_HINT_PATTERN.test(e['aliasHint'] as string) &&
    typeof e['createdAt'] === 'number' &&
    typeof e['lastUsed'] === 'number'
  );
}

function sanitizeStore(raw: unknown): PIVStore {
  if (typeof raw !== 'object' || raw === null) return emptyStore();
  const r = raw as Record<string, unknown>;
  if (r['version'] !== PIV_VERSION || !Array.isArray(r['entries'])) return emptyStore();
  const entries = (r['entries'] as unknown[]).filter(isValidEntry);
  return {
    version: PIV_VERSION,
    entries,
    lastModified: typeof r['lastModified'] === 'number' ? (r['lastModified'] as number) : Date.now(),
  };
}

export async function loadStore(): Promise<PIVStore> {
  const area = localArea();
  if (!area) return emptyStore();
  try {
    const data = await area.get(PIV_STORAGE_KEY);
    return sanitizeStore((data as Record<string, unknown>)[PIV_STORAGE_KEY]);
  } catch {
    return emptyStore();
  }
}

async function persist(store: PIVStore): Promise<void> {
  const area = localArea();
  if (!area) return;
  try {
    await area.set({ [PIV_STORAGE_KEY]: store });
  } catch {
    // ignore — persistence is best-effort
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `piv-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export interface NewEntryDraft {
  category: PIVCategory;
  label: string;
  value: string;
  aliasHint: string;
}

/**
 * Validate a draft. Returns an error message, or null when valid.
 * Invalid drafts are REJECTED with a reason — never silently fixed — because
 * a malformed aliasHint would fail closed the firewall (FIREWALL_BAD_ALIAS)
 * on every subsequent agent run.
 */
export function validateDraft(draft: NewEntryDraft): string | null {
  if (!PIV_CATEGORIES.has(draft.category)) return 'Unknown category.';
  if (draft.label.trim().length === 0) return 'Label is required.';
  if (draft.value.length === 0) return 'Value is required.';
  if (!ALIAS_HINT_PATTERN.test(draft.aliasHint)) {
    return 'Alias must look like USER_EMAIL_1 (USER_<CATEGORY>_<n>).';
  }
  return null;
}

export async function addEntry(
  draft: NewEntryDraft,
): Promise<{ ok: true; entry: PIVEntry } | { ok: false; error: string }> {
  const invalid = validateDraft(draft);
  if (invalid !== null) return { ok: false, error: invalid };
  const store = await loadStore();
  if (store.entries.some((e) => e.aliasHint === draft.aliasHint)) {
    return { ok: false, error: 'That alias is already used by another entry.' };
  }
  const now = Date.now();
  const entry: PIVEntry = {
    id: newId(),
    category: draft.category,
    label: draft.label.trim(),
    value: draft.value,
    aliasHint: draft.aliasHint,
    createdAt: now,
    lastUsed: 0,
  };
  store.entries.push(entry);
  store.lastModified = now;
  await persist(store);
  return { ok: true, entry };
}

export async function updateEntry(
  id: string,
  patch: Partial<Pick<PIVEntry, 'label' | 'value' | 'aliasHint'>>,
): Promise<{ ok: true; entry: PIVEntry } | { ok: false; error: string }> {
  const store = await loadStore();
  const entry = store.entries.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'Entry not found.' };
  const next: PIVEntry = {
    ...entry,
    label: patch.label !== undefined ? patch.label.trim() : entry.label,
    value: patch.value !== undefined ? patch.value : entry.value,
    aliasHint: patch.aliasHint !== undefined ? patch.aliasHint : entry.aliasHint,
  };
  if (next.label.length === 0) return { ok: false, error: 'Label is required.' };
  if (next.value.length === 0) return { ok: false, error: 'Value is required.' };
  if (!ALIAS_HINT_PATTERN.test(next.aliasHint)) {
    return { ok: false, error: 'Alias must look like USER_EMAIL_1 (USER_<CATEGORY>_<n>).' };
  }
  if (store.entries.some((e) => e.id !== id && e.aliasHint === next.aliasHint)) {
    return { ok: false, error: 'That alias is already used by another entry.' };
  }
  Object.assign(entry, next);
  store.lastModified = Date.now();
  await persist(store);
  return { ok: true, entry };
}

export async function deleteEntry(id: string): Promise<boolean> {
  const store = await loadStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.id !== id);
  if (store.entries.length === before) return false;
  store.lastModified = Date.now();
  await persist(store);
  return true;
}

/**
 * Record an alias use. Fire-and-forget by contract: callers must never await
 * this from a run path, and it never throws.
 */
export function touchEntry(aliasHint: string): void {
  try {
    void (async () => {
      try {
        const store = await loadStore();
        const entry = store.entries.find((e) => e.aliasHint === aliasHint);
        if (!entry) return;
        entry.lastUsed = Date.now();
        store.lastModified = entry.lastUsed;
        await persist(store);
      } catch {
        // ignore — usage tracking is best-effort
      }
    })();
  } catch {
    // ignore — never throw into callers
  }
}

export function serializeBackup(store: PIVStore): string {
  return JSON.stringify(store, null, 2);
}

export function backupFilename(now: Date = new Date()): string {
  return `privagent-data-backup-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Validate an import payload BEFORE merging. Returns the entries on success,
 * or an error message. Never throws, never partially imports.
 */
export function parseBackup(text: string): { ok: true; entries: PIVEntry[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'That file is not a PrivAgent backup.' };
  }
  const r = raw as Record<string, unknown>;
  if (r['version'] !== PIV_VERSION) {
    return { ok: false, error: 'Unsupported backup version.' };
  }
  if (!Array.isArray(r['entries'])) {
    return { ok: false, error: 'That file is not a PrivAgent backup.' };
  }
  const entries = (r['entries'] as unknown[]).filter(isValidEntry);
  if (entries.length !== (r['entries'] as unknown[]).length) {
    return { ok: false, error: 'Some entries are malformed — nothing was imported.' };
  }
  return { ok: true, entries };
}

export async function importBackup(
  entries: PIVEntry[],
  mode: 'merge' | 'replace',
): Promise<PIVStore> {
  if (mode === 'replace') {
    const store: PIVStore = { version: PIV_VERSION, entries, lastModified: Date.now() };
    await persist(store);
    return store;
  }
  const store = await loadStore();
  const known = new Set(store.entries.map((e) => e.aliasHint));
  for (const entry of entries) {
    if (!known.has(entry.aliasHint)) {
      store.entries.push({ ...entry, id: newId() });
      known.add(entry.aliasHint);
    }
  }
  store.lastModified = Date.now();
  await persist(store);
  return store;
}
