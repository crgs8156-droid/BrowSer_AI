// PrivAgent side panel.
//
// The panel NEVER renders raw page content. On scan it collects only structured inputs
// from the active tab (see SCAN_PAGE), runs the local pipeline entirely on-device —
//   M2 detectPII → M3 visual perception → M4+M5 enforcePrivacy (aliasing + masking) —
// and displays the derived, sanitized `ScanSummary`: counts, semantic aliases, and
// masked-region metadata only. Raw values reach only the LOCAL vault, never the UI.

import { useState } from 'react';
import { VisualStatus } from './VisualStatus';
import { AgentTask } from './AgentTask';
import { detectPII } from '../perception/pii';
import { createVisualPerceptionService } from '../perception/visual';
import type { VisualPerceptionService } from '../perception/visual';
import { enforcePrivacy } from '../sanitizer';
import { toSensitiveCategory } from '../sanitizer/alias';
import { createLocalVault } from '../vault';
import type { PolicySignals, RiskSeverity } from '../types/contracts';
import { SCAN_PAGE, SCROLL_VIEWPORT, type ScanPageResponse, type ScrollViewportResponse } from '../types/messages';
import { buildScanSummary, type ScanFindingView, type ScanSummary } from '../scan';
import { ocrTrace } from '../diag/ocr-trace';
import { recordEvent, sessionTelemetry } from './telemetry-session';
import { TelemetryPanel } from './TelemetryPanel';
import { captureViaBackground } from './capture';

type ScanState = 'idle' | 'scanning' | 'done' | 'restricted' | 'error';

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

  const runScan = async () => {
    setState('scanning');
    setSummary(null);
    setShowRegions(false);

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

      // M4 (policy) + M5 (enforce): alias every recoverable value into the LOCAL vault,
      // mask visual regions, and produce a structured, safe result. `redact` runs on the
      // real page text here; the vault (local, in memory) holds the alias↔value mapping.
      const signals: PolicySignals = { entities, visual, restricted: false };
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
    <main className="p-4 text-sm">
      <h1 className="text-base font-semibold">PrivAgent</h1>
      <p className="mt-1 text-neutral-500">Privacy-preserving AI browser agent</p>

      <button
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        onClick={runScan}
        disabled={state === 'scanning'}
      >
        {state === 'scanning' ? 'Scanning…' : summary !== null ? 'Scan again' : 'Scan Page'}
      </button>

      {state === 'scanning' && <p className="mt-3 text-neutral-500">Scan: … analysing page</p>}
      {state === 'restricted' && (
        <p className="mt-3 text-amber-600">Scan: ⚠️ Restricted page — browser security</p>
      )}
      {state === 'error' && (
        <p className="mt-3 text-red-500">
          Scan: ✕ Could not read this page. If it was open before PrivAgent loaded, reload it.
        </p>
      )}

      {state === 'done' && summary !== null && (
        <section className="mt-4" aria-label="Scan findings">
          <p className="font-medium text-green-700">Scan: ✓ Complete</p>
          <p className="mt-1">
            Sensitive items: <strong>{summary.total}</strong>
          </p>
          <p className="text-neutral-600">
            Text regions: {summary.textCount} · Image/OCR regions: {summary.imageCount}
          </p>

          {summary.blocked && (
            <p className="mt-1 text-red-600">
              ⛔ Critical credential present — outbound blocked (fail-closed)
            </p>
          )}

          {summary.total === 0 ? (
            <p className="mt-3 text-neutral-500">No sensitive data detected.</p>
          ) : (
            <ul className="mt-3 space-y-1" data-testid="findings">
              {summary.findings.map((finding) => (
                <li key={finding.displayId} className="text-neutral-800">
                  <span aria-hidden="true">{findingIcon(finding)}</span>{' '}
                  <span className="text-xs uppercase tracking-wide text-neutral-500">
                    {finding.label}
                  </span>{' '}
                  <span className="font-mono">{finding.displayId}</span>
                  {finding.section !== undefined && (
                    <span className="text-neutral-500"> · Page section {finding.section}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {summary.total > 0 && (
            <button
              className="mt-3 text-xs text-blue-600 underline"
              onClick={() => setShowRegions((value) => !value)}
            >
              {showRegions ? 'Hide regions' : 'View regions'}
            </button>
          )}

          {showRegions && (
            <ul className="mt-2 space-y-1 text-xs text-neutral-500" data-testid="regions">
              {summary.findings.map((finding) => (
                <li key={`region-${finding.displayId}`}>
                  <span className="font-mono">{finding.displayId}</span> — {finding.kind}
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

      <VisualStatus />
      <AgentTask />
      <TelemetryPanel />
    </main>
  );
}
