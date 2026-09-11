// Lightweight trace emitter — zero overhead when debug off.

export interface TraceEvent {
  stage: string;
  detail?: string;
  durationMs?: number;
  isError?: boolean;
}

const MAX_TRACE = 50;
let events: Array<TraceEvent & { at: number }> = [];
let startAt: number | null = null;
let enabled = false;

export function setTraceEnabled(on: boolean) {
  enabled = on;
  if (!on) { events = []; startAt = null; }
}

export function isTraceEnabled(): boolean { return enabled; }

export function startTrace() {
  events = [];
  startAt = performance.now();
}

export function emitTrace(event: TraceEvent) {
  if (!enabled) return;
  const at = startAt !== null ? performance.now() - startAt : 0;
  // Truncate selector to 30 chars, never raw values (canary tested)
  let detail = event.detail;
  if (detail && detail.length > 30) detail = detail.slice(0, 30);
  events.push({ ...event, detail, at });
  if (events.length > MAX_TRACE) events.shift();
}

export function getTrace(): Array<TraceEvent & { at: number; formatted: string }> {
  return events.map((e) => {
    const ts = `[${(e.at / 1000).toFixed(3).padStart(6, '0')}]`;
    const icon = e.isError ? '\u274c' : '\u2705';
    const d = e.detail ? ` ${e.detail}` : '';
    const dur = e.durationMs !== undefined ? ` (${e.durationMs}ms)` : '';
    return { ...e, formatted: `${ts} ${icon} ${e.stage}${d}${dur}` };
  });
}

export function clearTrace() { events = []; startAt = null; }
