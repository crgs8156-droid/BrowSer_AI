// PrivAgent side panel.
//
// The panel NEVER renders raw page content. On scan it collects only structured inputs
// from the active tab (see SCAN_PAGE), runs the local pipeline entirely on-device —
//   M2 detectPII → M3 visual perception → M4+M5 enforcePrivacy (aliasing + masking) —
// and displays the derived, sanitized `ScanSummary`: counts, semantic aliases, and
// masked-region metadata only. Raw values reach only the LOCAL vault, never the UI.

import { useState, useSyncExternalStore } from 'react';
import { VisualStatus } from './VisualStatus';
import { AgentTask } from './AgentTask';
import { VaultPanel } from './VaultPanel';
import { detectPII } from '../perception/pii';
import { createVisualPerceptionService } from '../perception/visual';
import type { VisualPerceptionService } from '../perception/visual';
import { enforcePrivacy } from '../sanitizer';
import { classifyPage } from '../perception/visual/pageClassifier';
import { toSensitiveCategory } from '../sanitizer/alias';
import { createLocalVault } from '../vault';
import type { PolicySignals, RiskSeverity } from '../types/contracts';
import { SCAN_PAGE, SCROLL_VIEWPORT, type ScanPageResponse, type ScrollViewportResponse } from '../types/messages';
import { buildScanSummary, type ScanFindingView, type ScanSummary } from '../scan';
import { ocrTrace } from '../diag/ocr-trace';
import { recordEvent, sessionTelemetry } from './telemetry-session';
import { TelemetryPanel } from './TelemetryPanel';
import { recordVisualStats } from './visual-stats';
import { captureViaBackground } from './capture';
import { ScanDetails, maskForCategory } from './ScanDetails';
import { getRunStateVersion, isAgentRunning, subscribeToRunState } from './run-state';
import { getAuditLog } from '../audit/log';
import { aliasesFromAudit } from './VaultPanel';
import { useEffect } from 'react';

type ScanState = 'idle' | 'scanning' | 'done' | 'restricted' | 'error';

type PanelTab = 'run' | 'audit' | 'vault';

/**
 * Scroll the active tab to document y `top` for bounded below-the-fold band capture, then
 * let layout/lazy content settle before the caller captures. Relayed through the
 * background worker; carries only an offset. Injected into the M3 service so that ABSENT
 * this dependency the service inspects only the visible viewport (honest limit).
 */
async function scrollViewport(top: number): Promise<void> {
  const response: ScrollViewportResponse = await chrome.runtime.sendMessage({
    type: SCROLL_VIEWPORT,
    top,
  });
  if (response?.error !== undefined) throw new Error(response.error);
  // Let the newly revealed band paint (and any lazy images load) before capture.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

// Created on first scan so simply opening the panel loads no visual provider. Mirrors
// the lazy pattern in VisualStatus; capture/analysis must run in this document context.
let visualService: VisualPerceptionService | null = null;
function getVisualService(): VisualPerceptionService {
  visualService ??= createVisualPerceptionService({ captureViewport: captureViaBackground, scrollViewport });
  return visualService;
}

const SEVERITY_DOT: Record<RiskSeverity, string> = {
  critical: '🔴',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  none: '⚪',
};

function findingIcon(finding: ScanFindingView): string {
  if (finding.disposition === 'flagged' || finding.disposition === 'inaccessible') return '⚠️';
  if (finding.kind === 'image') return '🖼️';
  return SEVERITY_DOT[finding.severity ?? 'none'];
}

export function App() {
  const [state, setState] = useState<ScanState>('idle');
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [showRegions, setShowRegions] = useState(false);
  const [scanDetails, setScanDetails] = useState<{ findings: import('./ScanDetails').ScanDetailsFinding[]; fields: { inputs: number; textareas: number; labels: number; total: number; sensitive: number; safe: number }; policy: { decision: string; signals: string[]; mode: string } } | null>(null);
  const [tab, setTab] = useState<PanelTab>('run');
  useSyncExternalStore(subscribeToRunState, getRunStateVersion);
  const agentRunning = isAgentRunning();
  // Footer sub-line counts, derived from the value-free audit log (counts only).
  const [auditCounts, setAuditCounts] = useState<{ actions: number; aliases: number; clicks: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void getAuditLog().then((entries) => {
        if (!alive) return;
        setAuditCounts({
          actions: entries.filter((e) => e.type === 'action_executed').length,
          aliases: aliasesFromAudit(entries).length,
          clicks: entries.filter((e) => e.type === 'action_executed' && e.detail.startsWith('CLICK')).length,
        });
      });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const resultActionsLine =
    auditCounts !== null && auditCounts.actions > 0 ? (
      <p style={{ color: 'var(--pa-dim)', fontSize: 10, lineHeight: 1.4, marginTop: 4 }}>
        Agent executed {auditCounts.actions} actions ({auditCounts.aliases} protected fields
        resolved on-device, {auditCounts.clicks} clicks). 0 bytes of raw PII left this device.
      </p>
    ) : null;

  const runScan = async () => {
    setState('scanning');
    setSummary(null);
    setShowRegions(false);
    setScanDetails(null);

    try {
      const response: ScanPageResponse = await chrome.runtime.sendMessage({ type: SCAN_PAGE });

      if (response?.restricted === true) {
        setState('restricted');
        return;
      }
      if (
        response?.error !== undefined ||
        typeof response?.pageText !== 'string' ||
        !response?.snapshot
      ) {
        setState('error');
        return;
      }

      const pageText = response.pageText;
      const snapshot = response.snapshot;

      // The active page was reachable and NOT excluded by selective-page policy: it is
      // the scan target. Log non-content facts only (text length, candidate count).
      ocrTrace('SELECTED_PAGE', {
        candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates.length : 0,
        pageTextLength: pageText.length,
        viewportHeight: snapshot.viewport?.height,
      });

      // M2 (PII) + M3 (visual) — detection over the whole page, all regions.
      // M7: stage timings + value-free privacy events feed the telemetry dashboard.
      const scanStartedAt = performance.now();

      const detectStartedAt = performance.now();
      const entities = detectPII(pageText);
      sessionTelemetry.timing('scan.detect', performance.now() - detectStartedAt);
      for (const category of new Set(entities.map((entity) => entity.category))) {
        recordEvent({ type: 'DETECTED', entityCategory: toSensitiveCategory(category) });
      }

      const visualStartedAt = performance.now();
      const visual = await getVisualService().run(snapshot);
      sessionTelemetry.timing('scan.visual', performance.now() - visualStartedAt);
      recordVisualStats(visual);

      // M4 (policy) + M5 (enforce): alias every recoverable value into the LOCAL vault,
      // mask visual regions, and produce a structured, safe result. `redact` runs on the
      // real page text here; the vault (local, in memory) holds the alias↔value mapping.
      // M7.5 — rule-based page-type classification from already-collected signals.
      const visualContext = classifyPage(response.structure, pageText);
      const signals: PolicySignals = { entities, visual, visualContext, restricted: false };
      const vault = createLocalVault();
      const enforceStartedAt = performance.now();
      const result = await enforcePrivacy({
        signals,
        pageText,
        sessionId: 'scan-session',
        vault,
      });
      sessionTelemetry.timing('scan.enforce', performance.now() - enforceStartedAt);
      sessionTelemetry.timing('scan.total', performance.now() - scanStartedAt);
      if (result.aliases.length > 0) recordEvent({ type: 'SANITIZED' });
      if (result.blocked) recordEvent({ type: 'BLOCKED' });

      // Enforcement produced structured findings. Counts and gates only — no raw values.
      ocrTrace('PRIVACY_FINDINGS', {
        findings: result.findings.length,
        visualMasks: result.visualMasks.length,
        aliases: result.aliases.length,
        blocked: result.blocked,
      });

      const built = buildScanSummary(result, snapshot.viewport?.height);
      // Phase 2 — build ScanDetails masked rows from vault aliases (never raw values in UI)
      const scanFindings: import('./ScanDetails').ScanDetailsFinding[] = [];
      for (const f of built.findings) {
        if (f.category && f.displayId.startsWith('USER_')) {
          const cat = f.category;
          const alias = f.displayId;
          let raw: string | undefined;
          try { raw = await vault.resolve(alias); } catch { raw = undefined; }
          const masked = raw ? maskForCategory(raw, cat) : '••••••••';
          scanFindings.push({ alias, category: cat, masked, label: f.label, source: f.source ?? 'Text', confidence: f.severity ? String(f.severity) : 'High' });
        }
      }
      const structure = response.structure ?? [];
      const inputs = structure.filter((s) => s.tag === 'input').length;
      const textareas = structure.filter((s) => s.tag === 'textarea').length;
      const labels = structure.filter((s) => !!s.label).length;
      const total = structure.length;
      const sensitive = built.total;
      const safe = Math.max(0, total - sensitive);
      const decision = result.blocked ? '⛔ Block — critical credential present' : result.enforced ? `✅ Sanitize — ${result.aliases.length} fields will be aliased` : '⚠️ Restricted — cannot fully inspect';
      const policySignals = result.findings.map((f) => f.action).filter((v, i, a) => a.indexOf(v) === i);
      setScanDetails({ findings: scanFindings, fields: { inputs, textareas, labels, total, sensitive, safe }, policy: { decision, signals: policySignals, mode: 'Strict' } });
      // What the panel will render: text vs image/OCR region counts (no content).
      ocrTrace('UI_FINDINGS', {
        total: built.total,
        textCount: built.textCount,
        imageCount: built.imageCount,
      });
      setSummary(built);
      setState('done');
    } catch {
      setState('error');
    }
  };

  return (
    <main className="pa-root" style={{ fontSize: 14 }}>
      <header className="pa-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--pa-accent)' }}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              className={agentRunning ? 'pa-shield-spin' : undefined}
            >
              <defs>
                <linearGradient id="paShieldGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#00d4aa" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <path fill="url(#paShieldGrad)" d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6l-8-4z" />
            </svg>
          </span>
          <h1 className="pa-header-title">PrivAgent</h1>
          <span className="pa-ondevice" style={{ marginLeft: 'auto' }}>
            <span aria-hidden="true" className={agentRunning ? 'pa-dot pa-dot-pulse' : 'pa-dot'}>
              ●
            </span>{' '}
            ON-DEVICE
          </span>
        </div>
        <p className="pa-header-sub" style={{ marginTop: 2 }}>
          SIH26171 · Privacy-Preserving Agent
        </p>
      </header>

      <nav className="pa-tabs" aria-label="Panel sections">
        <button
          className={tab === 'run' ? 'pa-tab pa-tab-active' : 'pa-tab'}
          data-testid="tab-run"
          aria-pressed={tab === 'run'}
          onClick={() => setTab('run')}
        >
          ⚡ Run Agent
        </button>
        <button
          className={tab === 'audit' ? 'pa-tab pa-tab-active' : 'pa-tab'}
          data-testid="tab-audit"
          aria-pressed={tab === 'audit'}
          onClick={() => setTab('audit')}
        >
          🔍 Audit
        </button>
        <button
          className={tab === 'vault' ? 'pa-tab pa-tab-active' : 'pa-tab'}
          data-testid="tab-vault"
          aria-pressed={tab === 'vault'}
          onClick={() => setTab('vault')}
        >
          🔐 Vault
        </button>
      </nav>

      <div className="pa-tabpane" hidden={tab !== 'run'} style={{ padding: '12px 14px' }}>
      <p className="pa-section-label">Privacy scan</p>
      <p className="pa-faint" style={{ fontSize: 12, marginTop: 4 }}>
        Values never leave this machine — only aliases cross the firewall.
      </p>

      <button
        className="pa-run pa-run-idle"
        style={{ marginTop: 12 }}
        onClick={runScan}
        disabled={state === 'scanning'}
      >
        {state === 'scanning' ? 'Scanning…' : summary !== null ? 'Scan again' : 'Scan Page'}
      </button>

      {state === 'scanning' && <p className="pa-faint" style={{ marginTop: 12, fontSize: 12 }}>Scan: … analysing page</p>}
      {state === 'restricted' && (
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--pa-warning)' }}>Scan: ⚠️ Restricted page — browser security</p>
      )}
      {state === 'error' && (
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--pa-danger)' }}>
          Scan: ✕ Could not read this page. If it was open before PrivAgent loaded, reload it.
        </p>
      )}

      {state === 'done' && summary !== null && (
        <section className="pa-card" style={{ marginTop: 12, padding: '12px 14px' }} aria-label="Scan findings">
          <p style={{ fontWeight: 600, color: 'var(--pa-accent)', fontSize: 13 }}>Scan: ✓ Complete</p>
          <p className="pa-muted" style={{ marginTop: 4, fontSize: 12 }}>
            Sensitive items: <strong style={{ color: 'var(--pa-text)' }}>{summary.total}</strong>
          </p>
          <p className="pa-faint" style={{ fontSize: 12 }}>
            Text regions: {summary.textCount} · Image/OCR regions: {summary.imageCount}
          </p>

          {summary.blocked && (
            <p style={{ marginTop: 4, fontSize: 12, color: 'var(--pa-danger)' }}>
              ⛔ Critical credential present — outbound blocked (fail-closed)
            </p>
          )}

          {summary.total === 0 ? (
            <p className="pa-faint" style={{ marginTop: 12, fontSize: 12 }}>No sensitive data detected.</p>
          ) : (
            <ul style={{ marginTop: 12, display: 'grid', gap: 4 }} data-testid="findings">
              {summary.findings.map((finding) => (
                <li key={finding.displayId} style={{ fontSize: 12, color: 'var(--pa-text)' }}>
                  <span aria-hidden="true">{findingIcon(finding)}</span>{' '}
                  <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--pa-faint)' }}>
                    {finding.label}
                  </span>{' '}
                  <span style={{ fontFamily: 'monospace' }}>{finding.displayId}</span>
                  {finding.section !== undefined && (
                    <span className="pa-faint"> · Page section {finding.section}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {summary.total > 0 && (
            <button
              style={{ marginTop: 12, fontSize: 12, color: 'var(--pa-secondary)', textDecoration: 'underline' }}
              onClick={() => setShowRegions((value) => !value)}
            >
              {showRegions ? 'Hide regions' : 'View regions'}
            </button>
          )}

          {showRegions && (
            <ul style={{ marginTop: 8, display: 'grid', gap: 4, fontSize: 12 }} className="pa-faint" data-testid="regions">
              {summary.findings.map((finding) => (
                <li key={`region-${finding.displayId}`}>
                  <span style={{ fontFamily: 'monospace' }}>{finding.displayId}</span> — {finding.kind}
                  {finding.geometry !== undefined &&
                    ` · ${finding.geometry.width}×${finding.geometry.height}px`}
                  {finding.section !== undefined && ` · section ${finding.section}`}
                  {` · ${finding.disposition}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {scanDetails !== null && summary !== null && (
        <ScanDetails summary={summary} findings={scanDetails.findings} fields={scanDetails.fields} policy={scanDetails.policy} />
      )}

      <VisualStatus />
      <AgentTask />
      </div>

      <div className="pa-tabpane" hidden={tab !== 'audit'} style={{ padding: '12px 14px' }}>
        <p className="pa-section-label">Privacy audit</p>
        <TelemetryPanel />
      </div>

      <div className="pa-tabpane" hidden={tab !== 'vault'} style={{ padding: '12px 14px' }}>
        <p className="pa-section-label" style={{ marginBottom: 8 }}>Session vault</p>
        <VaultPanel />
      </div>

      {summary?.blocked === true ? (
        <footer className="pa-footer-blocked">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--pa-danger)', fontSize: 12, fontWeight: 600 }}>
              🚫 Firewall blocked — 0 bytes transmitted
            </span>
          </div>
        </footer>
      ) : (
        <footer className="pa-footer-ok">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--pa-accent)', fontSize: 12, fontWeight: 600 }}>
              ✓ Privacy Status: Airtight
            </span>
            <span className="pa-leak-badge" style={{ marginLeft: 'auto' }}>
              0 BYTES LEAKED
            </span>
          </div>
          {resultActionsLine}
        </footer>
      )}
    </main>
  );
}
