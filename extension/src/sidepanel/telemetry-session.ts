// M7 — session-scoped telemetry for the side panel.
//
// A single `Telemetry` instance shared by the scan pipeline and the agent task, plus a
// minimal pub-sub so React components re-render when new counts/timings arrive. The
// value-free guarantee lives in the telemetry module itself (allowlist-copy on every
// event); this wrapper only adds fan-out — it never touches payloads.

import type { PrivacyEvent } from '../types/contracts';
import { createTelemetry, type Telemetry } from '../telemetry';

const delegate = createTelemetry();
const listeners = new Set<() => void>();

let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export const sessionTelemetry: Telemetry = {
  record(event: PrivacyEvent) {
    delegate.record(event);
    notify();
  },
  timing(name: string, ms: number) {
    delegate.timing(name, ms);
    notify();
  },
  eventCounts() {
    return delegate.eventCounts();
  },
  timings() {
    return delegate.timings();
  },
  exportSummary() {
    return delegate.exportSummary();
  },
  clear() {
    delegate.clear();
    notify();
  },
};

/** Subscribe to telemetry changes; returns an unsubscribe function. */
export function subscribeToTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic snapshot version for `useSyncExternalStore`. */
export function getTelemetryVersion(): number {
  return version;
}

/** Record one privacy event with the current timestamp. */
export function recordEvent(event: Omit<PrivacyEvent, 'timestamp'> & { timestamp?: number }): void {
  sessionTelemetry.record({ ...event, timestamp: event.timestamp ?? Date.now() } as PrivacyEvent);
}
