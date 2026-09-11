// "My Data" tab — Personal Identity Vault UI.
//
// Values are masked by default and revealed at most 5s at a time (timer with
// unmount cleanup). Add/edit/delete/export/import all operate on
// chrome.storage.local only. Nothing here emits events, writes logs,
// prints to consoles, or touches networks.

import { useEffect, useRef, useState } from 'react';
import {
  addEntry,
  backupFilename,
  deleteEntry,
  importBackup,
  loadStore,
  parseBackup,
  serializeBackup,
  updateEntry,
  type NewEntryDraft,
  type PIVCategory,
  type PIVEntry,
} from './store';
import { templatesForCategory } from './templates';
import { maskPivValue } from './mask';

const CATEGORY_META: Readonly<Record<PIVCategory, { title: string; icon: string }>> = {
  personal: { title: 'Personal', icon: '👤' },
  contact: { title: 'Contact', icon: '📞' },
  identity: { title: 'Identity', icon: '🪪' },
  financial: { title: 'Financial', icon: '💳' },
  professional: { title: 'Professional', icon: '💼' },
  custom: { title: 'Custom', icon: '⚙️' },
};

const CATEGORIES = Object.keys(CATEGORY_META) as PIVCategory[];

/** Relative time for "Last used" lines. Pure — tested. */
export function timeAgo(timestamp: number, now: number = Date.now()): string {
  if (!timestamp || timestamp <= 0) return 'Never used';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'Last used: just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last used: ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last used: ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Last used: ${days} day${days === 1 ? '' : 's'} ago`;
}

async function downloadText(filename: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function PIVPanel() {
  const [entries, setEntries] = useState<PIVEntry[]>([]);
  const [query, setQuery] = useState('');
  const [openSections, setOpenSections] = useState<Set<PIVCategory>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editAlias, setEditAlias] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addCategory, setAddCategory] = useState<PIVCategory>('contact');
  const [addTemplateIdx, setAddTemplateIdx] = useState<string>('');
  const [addLabel, setAddLabel] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addAlias, setAddAlias] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [showExportWarn, setShowExportWarn] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);
  const revealTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const refresh = async (): Promise<void> => {
    setEntries((await loadStore()).entries);
  };

  useEffect(() => {
    void refresh();
    const timers = revealTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const toggleSection = (category: PIVCategory): void => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const reveal = (id: string): void => {
    setRevealed((prev) => new Set(prev).add(id));
    const existing = revealTimers.current.get(id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      revealTimers.current.delete(id);
      setRevealed((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 5000);
    revealTimers.current.set(id, timer);
  };

  const hide = (id: string): void => {
    const existing = revealTimers.current.get(id);
    if (existing !== undefined) {
      clearTimeout(existing);
      revealTimers.current.delete(id);
    }
    setRevealed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const startEdit = (entry: PIVEntry): void => {
    setEditingId(entry.id);
    setEditLabel(entry.label);
    setEditValue(entry.value);
    setEditAlias(entry.aliasHint);
    setFormError(null);
  };

  const saveEdit = async (): Promise<void> => {
    if (editingId === null) return;
    const result = await updateEntry(editingId, {
      label: editLabel,
      value: editValue,
      aliasHint: editAlias,
    });
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setEditingId(null);
    setFormError(null);
    await refresh();
  };

  const confirmDelete = async (): Promise<void> => {
    if (deletingId === null) return;
    await deleteEntry(deletingId);
    setDeletingId(null);
    await refresh();
  };

  const openAdd = (): void => {
    setAddCategory('contact');
    setAddTemplateIdx('');
    setAddLabel('');
    setAddValue('');
    setAddAlias('');
    setFormError(null);
    setShowAdd(true);
  };

  const pickTemplate = (idx: string): void => {
    setAddTemplateIdx(idx);
    if (idx === '' || idx === 'custom') {
      if (idx === '') {
        setAddLabel('');
        setAddAlias('');
      }
      return;
    }
    const tpl = templatesForCategory(addCategory)[Number(idx)];
    if (tpl) {
      setAddLabel(tpl.label);
      setAddAlias(tpl.aliasHint);
    }
  };

  const saveAdd = async (): Promise<void> => {
    const draft: NewEntryDraft = {
      category: addCategory,
      label: addLabel,
      value: addValue,
      aliasHint: addAlias,
    };
    const result = await addEntry(draft);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setShowAdd(false);
    setFormError(null);
    await refresh();
  };

  const doExport = async (): Promise<void> => {
    const store = await loadStore();
    await downloadText(backupFilename(), serializeBackup(store));
    setShowExportWarn(false);
  };

  const doImportFile = async (file: File): Promise<void> => {
    setImportError(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError('Could not read that file.');
      return;
    }
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    await importBackup(parsed.entries, importMode);
    await refresh();
  };

  const q = query.trim().toLowerCase();
  const visible = (entry: PIVEntry): boolean => {
    if (q.length === 0) return true;
    return (
      entry.label.toLowerCase().includes(q) ||
      entry.aliasHint.toLowerCase().includes(q) ||
      CATEGORY_META[entry.category].title.toLowerCase().includes(q)
    );
  };

  return (
    <section className="pa-card" style={{ padding: '12px 14px' }} aria-label="My Data" data-testid="piv-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <p className="pa-section-label">👤 My Data</p>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="pa-chip" data-testid="piv-add-open" onClick={openAdd}>
            + Add
          </button>
          <button className="pa-chip" data-testid="piv-export-open" onClick={() => setShowExportWarn(true)}>
            📤 Export
          </button>
        </div>
      </div>
      <p className="pa-faint" style={{ fontSize: 11, marginTop: 4 }}>
        Stored locally · never leaves device
      </p>
      <p style={{ fontSize: 11, marginTop: 4, color: 'var(--pa-warning)' }} data-testid="piv-notice">
        Stored locally on this device only. Chrome profile protects this data.
      </p>

      <input
        className="pa-input"
        style={{ margin: '8px 0', fontSize: 12, padding: '8px 12px', borderRadius: 8 }}
        placeholder="🔍 Search fields..."
        data-testid="piv-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {CATEGORIES.map((category) => {
        const rows = entries.filter((e) => e.category === category && visible(e));
        const open = openSections.has(category);
        return (
          <div key={category} style={{ marginBottom: 4 }}>
            <button
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                width: '100%',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--pa-border)',
                borderRadius: 8,
                padding: '8px 12px',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--pa-muted)',
              }}
              data-testid={`piv-section-${category}`}
              aria-expanded={open}
              onClick={() => toggleSection(category)}
            >
              <span>
                {open ? '▼' : '►'} {CATEGORY_META[category].icon} {CATEGORY_META[category].title} ({rows.length})
              </span>
            </button>
            {open && (
              <div style={{ marginTop: 4 }}>
                {rows.length === 0 ? (
                  <p className="pa-faint" style={{ fontSize: 11, padding: '4px 12px' }}>
                    No entries yet.
                  </p>
                ) : (
                  rows.map((entry) => {
                    const isRevealed = revealed.has(entry.id);
                    const isEditing = editingId === entry.id;
                    const isDeleting = deletingId === entry.id;
                    return (
                      <div
                        key={entry.id}
                        style={{
                          background: isRevealed
                            ? 'rgba(0,212,170,0.06)'
                            : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${isRevealed ? 'rgba(0,212,170,0.2)' : 'var(--pa-border)'}`,
                          borderRadius: 8,
                          padding: '10px 12px',
                          marginBottom: 4,
                          display: 'grid',
                          gridTemplateColumns: '1fr auto',
                        }}
                        data-testid={`piv-entry-${entry.id}`}
                      >
                        <div>
                          {isEditing ? (
                            <>
                              <input
                                className="pa-input"
                                style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6 }}
                                data-testid={`piv-edit-label-${entry.id}`}
                                value={editLabel}
                                onChange={(e) => setEditLabel(e.target.value)}
                              />
                              <input
                                className="pa-input"
                                style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, marginTop: 4 }}
                                data-testid={`piv-edit-alias-${entry.id}`}
                                value={editAlias}
                                onChange={(e) => setEditAlias(e.target.value)}
                              />
                              <input
                                className="pa-input"
                                style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, marginTop: 4 }}
                                data-testid={`piv-edit-value-${entry.id}`}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                              />
                              {formError !== null && (
                                <p style={{ fontSize: 11, color: 'var(--pa-danger)', marginTop: 4 }}>{formError}</p>
                              )}
                              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                <button className="pa-chip" data-testid={`piv-edit-save-${entry.id}`} onClick={() => void saveEdit()}>
                                  Save
                                </button>
                                <button
                                  className="pa-chip"
                                  onClick={() => {
                                    setEditingId(null);
                                    setFormError(null);
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p style={{ fontSize: 11, color: 'var(--pa-muted)', fontWeight: 500 }}>{entry.label}</p>
                              <span
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: 9,
                                  background: 'rgba(99,102,241,0.1)',
                                  color: '#6366f1',
                                  borderRadius: 4,
                                  padding: '1px 5px',
                                  marginTop: 2,
                                  display: 'inline-block',
                                }}
                              >
                                {entry.aliasHint}
                              </span>
                              <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--pa-text)', fontFamily: 'monospace', marginTop: 4 }}>
                                {isRevealed ? entry.value : maskPivValue(entry.value, entry.category, entry.label)}
                              </p>
                              <p style={{ fontSize: 10, color: '#334155' }}>{timeAgo(entry.lastUsed)}</p>
                            </>
                          )}
                        </div>
                        {!isEditing && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <button
                              className="pa-chip"
                              data-testid={`piv-reveal-${entry.id}`}
                              title={isRevealed ? 'Hide value' : 'Reveal value for 5 seconds'}
                              onClick={() => {
                                if (isRevealed) hide(entry.id);
                                else reveal(entry.id);
                              }}
                            >
                              👁
                            </button>
                            <button className="pa-chip" data-testid={`piv-edit-${entry.id}`} title="Edit entry" onClick={() => startEdit(entry)}>
                              ✏️
                            </button>
                            <button className="pa-chip" data-testid={`piv-delete-${entry.id}`} title="Delete entry" onClick={() => setDeletingId(entry.id)}>
                              🗑️
                            </button>
                          </div>
                        )}
                        {isDeleting && (
                          <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
                            <p style={{ fontSize: 11, color: 'var(--pa-text)' }}>Delete {entry.label}? This cannot be undone.</p>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                              <button className="pa-chip" data-testid={`piv-delete-confirm-${entry.id}`} onClick={() => void confirmDelete()}>
                                Delete
                              </button>
                              <button className="pa-chip" onClick={() => setDeletingId(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}

      {showAdd && (
        <div className="pa-card" style={{ marginTop: 8, padding: 10 }} data-testid="piv-add-modal">
          <p className="pa-section-label">Add entry</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 8 }}>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className="pa-chip"
                data-testid={`piv-add-cat-${c}`}
                style={addCategory === c ? { borderColor: 'rgba(0,212,170,0.4)', color: '#00d4aa' } : undefined}
                onClick={() => {
                  setAddCategory(c);
                  setAddTemplateIdx('');
                  setAddLabel('');
                  setAddAlias('');
                }}
              >
                {CATEGORY_META[c].icon} {CATEGORY_META[c].title}
              </button>
            ))}
          </div>
          <select
            className="pa-input"
            style={{ marginTop: 8, fontSize: 12, borderRadius: 6 }}
            data-testid="piv-add-template"
            value={addTemplateIdx}
            onChange={(e) => pickTemplate(e.target.value)}
          >
            <option value="">Choose template…</option>
            {templatesForCategory(addCategory).map((tpl, i) => (
              <option key={tpl.aliasHint} value={String(i)}>
                {tpl.label} ({tpl.aliasHint})
              </option>
            ))}
            <option value="custom">Custom field</option>
          </select>
          <input
            className="pa-input"
            style={{ marginTop: 6, fontSize: 12, borderRadius: 6 }}
            placeholder="Label"
            data-testid="piv-add-label"
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
          />
          <input
            className="pa-input"
            style={{ marginTop: 6, fontSize: 12, borderRadius: 6 }}
            placeholder="Value"
            data-testid="piv-add-value"
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
          />
          <input
            className="pa-input"
            style={{ marginTop: 6, fontSize: 12, borderRadius: 6, fontFamily: 'monospace' }}
            placeholder="USER_EMAIL_1"
            data-testid="piv-add-alias"
            value={addAlias}
            onChange={(e) => setAddAlias(e.target.value)}
          />
          {formError !== null && (
            <p style={{ fontSize: 11, color: 'var(--pa-danger)', marginTop: 4 }} data-testid="piv-form-error">
              {formError}
            </p>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="pa-chip" data-testid="piv-add-save" onClick={() => void saveAdd()}>
              Save Entry
            </button>
            <button
              className="pa-chip"
              onClick={() => {
                setShowAdd(false);
                setFormError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showExportWarn && (
        <div className="pa-card" style={{ marginTop: 8, padding: 10 }} data-testid="piv-export-warn">
          <p style={{ fontSize: 12, color: 'var(--pa-warning)' }}>
            ⚠️ This file contains your real data. Store it securely. Never share it.
          </p>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="pa-chip" data-testid="piv-export-confirm" onClick={() => void doExport()}>
              Download anyway
            </button>
            <button className="pa-chip" onClick={() => setShowExportWarn(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <p className="pa-section-label">Import backup</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 11 }} className="pa-muted">
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="radio" name="piv-import-mode" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} />
            Merge with existing
          </label>
          <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="radio" name="piv-import-mode" checked={importMode === 'replace'} onChange={() => setImportMode('replace')} />
            Replace all
          </label>
          <label className="pa-chip" style={{ cursor: 'pointer' }} data-testid="piv-import-open">
            📥 Import backup
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              data-testid="piv-import-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void doImportFile(file);
              }}
            />
          </label>
        </div>
        {importError !== null && (
          <p style={{ fontSize: 11, color: 'var(--pa-danger)', marginTop: 4 }} data-testid="piv-import-error">
            {importError}
          </p>
        )}
      </div>
    </section>
  );
}
