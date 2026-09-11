import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addEntry,
  backupFilename,
  deleteEntry,
  emptyStore,
  importBackup,
  loadStore,
  parseBackup,
  serializeBackup,
  touchEntry,
  updateEntry,
  validateDraft,
} from '../../../extension/src/piv/store';

function stubLocalStorage() {
  const mem = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: mem.get(key) }),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) mem.set(k, v);
        },
        remove: async (key: string) => {
          mem.delete(key);
        },
      },
    },
  });
  return mem;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('piv store', () => {
  it('add entry → stored in chrome.storage.local', async () => {
    const mem = stubLocalStorage();
    const result = await addEntry({
      category: 'contact',
      label: 'Personal Email',
      value: 'user@example.test',
      aliasHint: 'USER_EMAIL_1',
    });
    expect(result.ok).toBe(true);
    expect(mem.has('piv_store')).toBe(true);
    const loaded = await loadStore();
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]).toMatchObject({
      label: 'Personal Email',
      value: 'user@example.test',
      aliasHint: 'USER_EMAIL_1',
    });
  });

  it('load entries → returns correct PIVEntry[] and rejects invalid aliasHint', async () => {
    stubLocalStorage();
    const bad = await addEntry({
      category: 'contact',
      label: 'Bad',
      value: 'x@example.test',
      aliasHint: 'NOT_AN_ALIAS',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('USER_EMAIL_1');
    const dup = await addEntry({
      category: 'contact',
      label: 'A',
      value: 'a@example.test',
      aliasHint: 'USER_EMAIL_1',
    });
    expect(dup.ok).toBe(true);
    const dup2 = await addEntry({
      category: 'contact',
      label: 'B',
      value: 'b@example.test',
      aliasHint: 'USER_EMAIL_1',
    });
    expect(dup2.ok).toBe(false);
  });

  it('update entry → validates, delete entry → removed from storage', async () => {
    stubLocalStorage();
    const added = await addEntry({
      category: 'identity',
      label: 'Aadhaar Number',
      value: '234567890123',
      aliasHint: 'USER_AADHAAR_1',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const updated = await updateEntry(added.entry.id, { label: 'Aadhaar' });
    expect(updated.ok).toBe(true);
    const badUpdate = await updateEntry(added.entry.id, { aliasHint: 'nope' });
    expect(badUpdate.ok).toBe(false);
    expect(await deleteEntry(added.entry.id)).toBe(true);
    expect(await deleteEntry(added.entry.id)).toBe(false);
    expect((await loadStore()).entries).toHaveLength(0);
  });

  it('export → correct JSON structure with version', async () => {
    stubLocalStorage();
    await addEntry({ category: 'contact', label: 'Mobile Number', value: '9876543210', aliasHint: 'USER_PHONE_1' });
    const json = serializeBackup(await loadStore());
    const parsed = JSON.parse(json) as { version: number; entries: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(backupFilename(new Date('2026-09-11T00:00:00Z'))).toBe('privagent-data-backup-2026-09-11.json');
  });

  it('import validates schema version BEFORE merging; malformed rejected, never crashes', async () => {
    stubLocalStorage();
    expect(parseBackup('not json{{{').ok).toBe(false);
    expect(parseBackup('{"version":2,"entries":[]}').ok).toBe(false);
    expect(parseBackup('{"version":1,"entries":[{"id":"x"}]}').ok).toBe(false);
    const good = parseBackup(
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'a', category: 'contact', label: 'E', value: 'v@example.test', aliasHint: 'USER_EMAIL_1', createdAt: 1, lastUsed: 0 },
        ],
      }),
    );
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    await importBackup(good.entries, 'merge');
    expect((await loadStore()).entries).toHaveLength(1);
    // Merge dedupes by aliasHint; replace swaps everything.
    await importBackup(good.entries, 'merge');
    expect((await loadStore()).entries).toHaveLength(1);
    await importBackup([], 'replace');
    expect((await loadStore()).entries).toHaveLength(0);
  });

  it('empty store when storage unavailable; validateDraft rejects clearly', async () => {
    expect(await loadStore()).toEqual(emptyStore());
    expect(validateDraft({ category: 'contact', label: '', value: 'x', aliasHint: 'USER_EMAIL_1' })).toContain('Label');
    expect(validateDraft({ category: 'contact', label: 'L', value: '', aliasHint: 'USER_EMAIL_1' })).toContain('Value');
    expect(validateDraft({ category: 'contact', label: 'L', value: 'x', aliasHint: 'bad' })).toContain('USER_EMAIL_1');
  });

  it('touchEntry stamps lastUsed without throwing when storage missing', () => {
    expect(() => touchEntry('USER_EMAIL_1')).not.toThrow();
  });
});
