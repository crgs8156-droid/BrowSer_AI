// Agent running-state fan-out for the sidepanel header.
//
// Mirrors `telemetry-session.ts`: a minimal pub-sub so the header badge/shield
// can animate while a task runs without prop-drilling through App → AgentTask.
// Boolean only — never content, never values.

const listeners = new Set<() => void>();

let running = false;
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Called by AgentTask alongside its own run-state transitions (additive only). */
export function setAgentRunning(value: boolean): void {
  if (value === running) return;
  running = value;
  notify();
}

/** Current running flag (read inside `useSyncExternalStore` subscribers). */
export function isAgentRunning(): boolean {
  return running;
}

/** Subscribe to running-flag changes; returns an unsubscribe function. */
export function subscribeToRunState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic snapshot version for `useSyncExternalStore`. */
export function getRunStateVersion(): number {
  return version;
}
