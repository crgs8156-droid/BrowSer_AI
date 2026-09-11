// Vault tab — read-only view of session aliases (Phase: dark theme).
//
// Source of truth is the session audit log (`alias_created` entries), the same
// store the Session Log reads — no new data flow, no vault access. Only alias
// NAMES are listed (grammar `USER_<CATEGORY>_<n>` is enforced upstream); values
// are never resolvable here, so the masked column is always bullets.

import { useEffect, useState } from 'react';
import { getAuditLog, type AuditEntry } from '../audit/log';

export interface VaultAliasRow {
  alias: string;
  category: string;
}

const ALIAS_CREATED = /^Alias (USER_[A-Z]+_\d+) created$/;

/** Distinct aliases mentioned by `alias_created` audit entries, in first-seen order. */
export function aliasesFromAudit(entries: AuditEntry[]): VaultAliasRow[] {
  const seen = new Map<string, VaultAliasRow>();
  for (const entry of entries) {
    if (entry.type !== 'alias_created') continue;
    const match = ALIAS_CREATED.exec(entry.detail);
    if (match?.[1] === undefined) continue;
    const alias = match[1];
    if (seen.has(alias)) continue;
    const category = alias.split('_')[1] ?? 'CUSTOM';
    seen.set(alias, { alias, category });
  }
  return [...seen.values()];
}

export function VaultPanel() {
  const [rows, setRows] = useState<VaultAliasRow[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void getAuditLog().then((entries) => {
        if (alive) setRows(aliasesFromAudit(entries));
      });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="pa-card" style={{ padding: '12px 14px' }} aria-label="Vault" data-testid="vault-panel">
      <p
        style={{
          background: 'rgba(0,212,170,0.08)',
          border: '1px solid rgba(0,212,170,0.15)',
          borderRadius: 8,
          padding: '8px 12px',
          color: 'var(--pa-accent)',
          fontSize: 12,
        }}
      >
        🔐 Session Vault Active
      </p>
      <p className="pa-faint" style={{ fontSize: 11, marginTop: 8 }}>
        Aliases resolve on this device only. Values are never listed here.
      </p>
      {rows.length === 0 ? (
        <p className="pa-faint" style={{ fontSize: 12, marginTop: 8 }} data-testid="vault-empty">
          No aliases yet — run a scan or an agent task.
        </p>
      ) : (
        <ul style={{ marginTop: 8 }} data-testid="vault-rows">
          {rows.map((row) => (
            <li
              key={row.alias}
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: 4,
              }}
            >
              <span className="pa-alias">{row.alias}</span>
              <span className="pa-cat-badge" style={{ marginLeft: 8 }}>
                {row.category}
              </span>
              <span className="pa-masked" style={{ display: 'block', marginTop: 2 }}>
                ••••••••
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
