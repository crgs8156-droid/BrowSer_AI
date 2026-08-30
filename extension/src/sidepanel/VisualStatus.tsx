// M3 side-panel status widget.
//
// Deliberately minimal: it reports pipeline STATE only. It renders derived labels,
// counts and timings — never page text, never OCR output, never pixels, never
// thumbnails. Region geometry is shown because coordinates are not content.

import { useState } from 'react';
import { createVisualPerceptionService } from '../perception/visual';
import type { VisualPerceptionService } from '../perception/visual';
import type { VisualPerceptionResult, VisualPerceptionStatus } from '../types/contracts';
import { COLLECT_VISUAL_CANDIDATES, type VisualCandidatesResponse } from '../types/messages';
import { captureViaBackground } from './capture';

const STATUS_LABELS: Record<VisualPerceptionStatus, string> = {
  not_required: 'Not required — DOM was sufficient',
  running: 'Running…',
  completed: 'Completed',
  unavailable: 'Unavailable in this context',
  restricted_page: 'Restricted page — browser security',
};

/** Human-readable explanations for the diagnostic reason codes the service emits, so
 *  the panel never shows a raw code like `VISUAL_CAPTURE_UNAVAILABLE` to the user. */
const REASON_LABELS: Record<string, string> = {
  VISUAL_CAPTURE_UNAVAILABLE:
    'The browser would not let this page be captured (e.g. a PDF, the New Tab page, or protected content). Text scanning still ran on the page.',
  rasterization_unsupported_in_context: 'This context cannot turn a capture into pixels.',
  browser_security_restriction: 'This is a browser-protected surface and cannot be inspected.',
  invalid_snapshot: 'The page structure could not be read.',
  run_in_progress: 'A visual check is already running.',
};

/** Honest one-line status for the OCR/vision content pass. */
const CONTENT_STATUS_LABELS: Record<string, string> = {
  ok: 'OCR/vision engine ran',
  not_available: 'No OCR/vision engine registered — image contents not read',
  failed: 'OCR/vision engine errored (fail closed — nothing fabricated)',
};

// Created on first use so simply opening the panel loads no provider.
let service: VisualPerceptionService | null = null;
function getService(): VisualPerceptionService {
  service ??= createVisualPerceptionService({ captureViewport: captureViaBackground });
  return service;
}

const RESTRICTED_RESULT: VisualPerceptionResult = {
  status: 'restricted_page',
  supported: false,
  reason: 'browser_security_restriction',
  observations: [],
  metrics: {
    candidatesConsidered: 0,
    regionsSelected: 0,
    regionsProcessed: 0,
    regionsFromCache: 0,
    durationMs: 0,
  },
};

export function VisualStatus() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<VisualPerceptionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runVisualCheck = async () => {
    setError(null);
    setRunning(true);
    try {
      const response: VisualCandidatesResponse = await chrome.runtime.sendMessage({
        type: COLLECT_VISUAL_CANDIDATES,
      });

      if (response?.restricted === true) {
        setResult(RESTRICTED_RESULT);
        return;
      }
      if (response?.error !== undefined || !response?.snapshot) {
        setError('Could not read page structure.');
        return;
      }

      setResult(await getService().run(response.snapshot));
    } catch {
      setError('Visual perception could not run.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mt-6 border-t border-neutral-200 pt-4">
      <h2 className="text-sm font-semibold">Visual perception</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Runs locally, only when the page structure alone is not enough.
      </p>

      <button
        className="mt-3 px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
        onClick={runVisualCheck}
        disabled={running}
      >
        {running ? 'Checking…' : 'Run Visual Check'}
      </button>

      {error !== null && <p className="mt-2 text-red-500">{error}</p>}

      {result !== null && (
        <div className="mt-3 text-xs">
          <p className="font-medium text-neutral-700">
            {running ? STATUS_LABELS.running : STATUS_LABELS[result.status]}
          </p>
          {result.reason !== undefined && (
            <p className="mt-1 text-neutral-500">
              Reason: {result.reason}
              {REASON_LABELS[result.reason] !== undefined && ` — ${REASON_LABELS[result.reason]}`}
            </p>
          )}
          {result.reasonDetail !== undefined && result.reasonDetail.length > 0 && (
            // The browser's own capture-failure string (an API diagnostic, never pixels or
            // page text). Shown so the actual cause of an "unavailable" is visible, not hidden.
            <p className="mt-1 text-neutral-400" data-testid="reason-detail">
              Detail: {result.reasonDetail}
            </p>
          )}
          <p className="mt-1 text-neutral-500">
            {result.metrics.regionsProcessed} analysed · {result.metrics.regionsFromCache} cached ·{' '}
            {result.metrics.durationMs} ms
          </p>
          {result.contentStatus !== undefined && (
            <p className="mt-1 text-neutral-500">
              OCR: {CONTENT_STATUS_LABELS[result.contentStatus] ?? result.contentStatus}
            </p>
          )}
          <ul className="mt-2">
            {result.observations.map((observation) => (
              <li key={observation.region.id} className="text-neutral-700">
                {observation.observations.join(', ')} ({observation.confidence.toFixed(2)}) —{' '}
                {observation.region.width}×{observation.region.height}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
