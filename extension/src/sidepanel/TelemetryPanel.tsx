// M7 — telemetry dashboard section (rubric #4: client-side resource utilization).
//
// Renders the session's privacy-event counts and stage-timing percentiles from the
// session telemetry. BY DESIGN this panel can only ever show counts and milliseconds:
// the telemetry recorder's allowlist-copy makes raw values impossible here
// (CONTRIBUTING.md §5 Rule 4), so the dashboard is evidence, not a leak surface.

import { useSyncExternalStore } from 'react';
import {
  getTelemetryVersion,
  sessionTelemetry,
  subscribeToTelemetry,
} from './telemetry-session';

export function TelemetryPanel() {
  useSyncExternalStore(subscribeToTelemetry, getTelemetryVersion);
  const summary = sessionTelemetry.exportSummary();
  const hasEvents = summary.events.some((row) => row.count > 0);
  const hasTimings = summary.timings.length > 0;

  return (
    <section className="mt-6 border-t border-neutral-200 pt-4" aria-label="Telemetry" data-testid="telemetry">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Telemetry</h2>
        <button
          className="text-xs text-neutral-500 underline"
          onClick={() => sessionTelemetry.clear()}
          disabled={!hasEvents && !hasTimings}
        >
          Reset
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        Counts and stage timings only — never values (fail-closed recorder).
      </p>

      {!hasEvents && !hasTimings ? (
        <p className="mt-2 text-xs text-neutral-500">No telemetry yet — run a scan or an agent task.</p>
      ) : (
        <>
          {hasEvents && (
            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs" data-testid="telemetry-events">
              {summary.events
                .filter((row) => row.count > 0)
                .map((row) => (
                  <span key={row.type} className="text-neutral-700">
                    {row.type}: <strong>{row.count}</strong>
                  </span>
                ))}
            </div>
          )}
          {hasTimings && (
            <table className="mt-3 w-full text-xs" data-testid="telemetry-timings">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="font-medium">Stage</th>
                  <th className="font-medium">Runs</th>
                  <th className="font-medium">p50 ms</th>
                  <th className="font-medium">p95 ms</th>
                  <th className="font-medium">max ms</th>
                </tr>
              </thead>
              <tbody>
                {summary.timings.map((row) => (
                  <tr key={row.name} className="border-t border-neutral-100">
                    <td className="py-0.5 font-mono">{row.name}</td>
                    <td>{row.count}</td>
                    <td>{row.p50Ms.toFixed(1)}</td>
                    <td>{row.p95Ms.toFixed(1)}</td>
                    <td>{row.maxMs.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
