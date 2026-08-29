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

const STATUS_LABELS: Record<VisualPerceptionStatus, string> = {
  not_required: 'Not required — DOM was sufficient',
  running: 'Running…',
  completed: 'Completed',
  unavailable: 'Unavailable in this context',
  restricted_page: 'Restricted page — browser security',
};

// Created on first use so simply opening the panel loads no provider.
let service: VisualPerceptionService | null = null;
function getService(): VisualPerceptionService {
  service ??= createVisualPerceptionService();
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
            <p className="mt-1 text-neutral-500">Reason: {result.reason}</p>
          )}
          <p className="mt-1 text-neutral-500">
            {result.metrics.regionsProcessed} analysed · {result.metrics.regionsFromCache} cached ·{' '}
            {result.metrics.durationMs} ms
          </p>
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
