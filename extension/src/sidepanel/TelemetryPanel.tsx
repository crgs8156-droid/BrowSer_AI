// M7 — telemetry dashboard section (rubric #4: client-side resource utilization).
//
// Renders the session's privacy-event counts and stage-timing percentiles from the
// session telemetry. BY DESIGN this panel can only ever show counts and milliseconds:
// the telemetry recorder's allowlist-copy makes raw values impossible here
// (CONTRIBUTING.md §5 Rule 4), so the dashboard is evidence, not a leak surface.

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  AUDIT_ICONS,
  auditExportFilename,
  formatAuditTime,
  getAuditLog,
  serializeAuditLog,
  type AuditEntry,
} from '../audit/log';
import { exportReportAsJSON } from '../report/generate';
import { loadStore } from '../piv/store';
import {
  getTelemetryVersion,
  sessionTelemetry,
  subscribeToTelemetry,
} from './telemetry-session';

export function TelemetryPanel() {
  useSyncExternalStore(subscribeToTelemetry, getTelemetryVersion);
  const summary = sessionTelemetry.exportSummary();
  // Phase 3 — session audit log, refreshed every 2s (cheap local read).
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [reportToast, setReportToast] = useState<string | null>(null);
  // PIV status: counts only (entry count + used categories from audit), never values.
  const [pivTotal, setPivTotal] = useState<number | null>(null);
  const [pivUsed, setPivUsed] = useState<string[]>([]);
  const [pivUnused, setPivUnused] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void getAuditLog().then((entries) => {
        if (alive) setAuditEntries(entries);
      });
      // PIV status rides the same 2s tick: entry count from local storage,
      // used categories from value-free alias_created audit entries.
      void (async () => {
        try {
          const [entries, store] = await Promise.all([getAuditLog(), loadStore()]);
          if (!alive) return;
          const used = new Set<string>();
          for (const entry of entries) {
            if (entry.type !== 'alias_created') continue;
            const match = /^Alias USER_([A-Z]+)_\d+ created$/.exec(entry.detail);
            if (match?.[1] !== undefined) used.add(match[1]);
          }
          const all = new Set(
            store.entries.map((e) => e.aliasHint.split('_')[1] ?? 'CUSTOM'),
          );
          setPivTotal(store.entries.length);
          setPivUsed([...used].sort());
          setPivUnused([...all].filter((a) => !used.has(a)).sort());
        } catch {
          // ignore — status is best-effort
        }
      })();
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const exportAudit = (): void => {
    const blob = new Blob([serializeAuditLog(auditEntries)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = auditExportFilename();
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  const hasEvents = summary.events.some((row) => row.count > 0);
  const hasTimings = summary.timings.length > 0;

  return (
    <section className="pa-card" style={{ padding: '12px 14px' }} aria-label="Telemetry" data-testid="telemetry">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p className="pa-section-label">Privacy audit</p>
        <button
          className="pa-faint"
          style={{ fontSize: 12, textDecoration: 'underline' }}
          onClick={() => sessionTelemetry.clear()}
          disabled={!hasEvents && !hasTimings}
        >
          Reset
        </button>
      </div>
      <p className="pa-faint" style={{ marginTop: 4, fontSize: 11 }}>
        Counts and stage timings only — never values (fail-closed recorder).
      </p>

      {!hasEvents && !hasTimings ? (
        <p className="pa-faint" style={{ marginTop: 8, fontSize: 12 }}>No telemetry yet — run a scan or an agent task.</p>
      ) : (
        <>
          {hasEvents && (
            <div className="pa-audit-card" style={{ marginTop: 8, marginBottom: 0 }} data-testid="telemetry-events">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', fontSize: 12 }}>
              {summary.events
                .filter((row) => row.count > 0)
                .map((row) => (
                  <span key={row.type} className="pa-muted">
                    {row.type}: <strong style={{ color: 'var(--pa-text)' }}>{row.count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasTimings && (
            <table className="pa-audit-card" style={{ marginTop: 8, marginBottom: 0, width: '100%', fontSize: 12 }} data-testid="telemetry-timings">
              <thead>
                <tr style={{ textAlign: 'left' }} className="pa-faint">
                  <th style={{ fontWeight: 500 }}>Stage</th>
                  <th style={{ fontWeight: 500 }}>Runs</th>
                  <th style={{ fontWeight: 500 }}>p50 ms</th>
                  <th style={{ fontWeight: 500 }}>p95 ms</th>
                  <th style={{ fontWeight: 500 }}>max ms</th>
                </tr>
              </thead>
              <tbody>
                {summary.timings.map((row) => (
                  <tr key={row.name} style={{ borderTop: '1px solid var(--pa-border)' }}>
                    <td style={{ padding: '2px 0', fontFamily: 'monospace', color: 'var(--pa-text)' }}>{row.name}</td>
                    <td className="pa-muted">{row.count}</td>
                    <td className="pa-muted">{row.p50Ms.toFixed(1)}</td>
                    <td className="pa-muted">{row.p95Ms.toFixed(1)}</td>
                    <td className="pa-muted">{row.maxMs.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {reportToast !== null && (
        <p style={{ marginTop: 8, fontSize: 12, color: 'var(--pa-accent)' }} data-testid="report-toast">
          {reportToast}
        </p>
      )}

      <div className="pa-audit-card" style={{ marginTop: 8, marginBottom: 0 }} aria-label="Session Log">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <p className="pa-section-label">Session Log</p>
          <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="pa-faint"
            style={{ fontSize: 12, textDecoration: 'underline' }}
            data-testid="audit-export"
            onClick={exportAudit}
            disabled={auditEntries.length === 0}
          >
            Export JSON
          </button>
          <button
            style={{ fontSize: 12, borderRadius: 8, padding: '8px 14px', background: 'color-mix(in srgb, var(--pa-secondary) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--pa-secondary) 20%, transparent)', color: 'var(--pa-secondary)' }}
            data-testid="report-export"
            onClick={() => {
              void exportReportAsJSON().then((started) => {
                setReportToast(
                  started ? 'Report downloaded — 0 raw values included' : 'Report unavailable here',
                );
              });
            }}
          >
            📊 Export Report
          </button>
          </div>
        </div>
        {auditEntries.length === 0 ? (
          <p className="pa-faint" style={{ marginTop: 4, fontSize: 12 }}>No audit events yet.</p>
        ) : (
          <ul className="pa-steplog" style={{ marginTop: 8, maxHeight: 192 }} data-testid="audit-log">
            {auditEntries.slice(-20).map((entry) => (
              <li key={`${entry.timestamp}-${entry.type}-${entry.stepNumber ?? ''}`}>
                <span style={{ color: 'var(--pa-dim)' }}>{formatAuditTime(entry.timestamp)}</span>{' '}
                <span aria-hidden="true">{AUDIT_ICONS[entry.type]}</span>{' '}
                <span>{entry.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pa-audit-card" style={{ marginTop: 8, marginBottom: 0 }} aria-label="PIV Status" data-testid="piv-status">
        <p className="pa-section-label">🗄️ PIV Status</p>
        {pivTotal === null || pivTotal === 0 ? (
          <p className="pa-faint" style={{ marginTop: 4, fontSize: 12 }}>
            No personal data entries yet — open the My Data tab to add some.
          </p>
        ) : (
          <>
            <p style={{ marginTop: 4, fontSize: 12, color: 'var(--pa-text)' }}>
              {pivTotal} personal data {pivTotal === 1 ? 'entry' : 'entries'} available
            </p>
            <p className="pa-muted" style={{ marginTop: 2, fontSize: 12 }}>
              Last agent run used: {pivUsed.length > 0 ? `${pivUsed.join(', ')} (${pivUsed.length} of ${pivTotal})` : 'none yet'}
            </p>
            {pivUnused.length > 0 && (
              <p className="pa-faint" style={{ marginTop: 2, fontSize: 12 }}>
                Entries never used: {pivUnused.join(', ')} (update recommended)
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
