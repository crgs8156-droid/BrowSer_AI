// M7 — telemetry / audit log (blueprint §13 Dashboard input, §4 module table).
//
// Records PRIVACY EVENTS and STAGE TIMINGS only. The value-free invariant
// (CLAUDE.md §5 Rule 4, blueprint Invariant 3) is enforced BY CONSTRUCTION: the
// recorder copies a fixed allowlist of fields from each event and drops everything
// else, so a caller cannot smuggle a raw value into the log even by accident.
// Timings carry names (fixed enum-ish strings) and milliseconds — never content.
//
// Storage: in-memory, session-scoped, bounded (oldest entries evicted) — the same
// volatility philosophy as the vault (threat-model R15: nothing sensitive at rest).
// The dashboard (§13) and the benchmark runner consume `exportSummary()`, which
// contains counts and percentile timings ONLY.

import type { PrivacyEvent, PrivacyEventType } from '../types/contracts';

export interface StageTiming {
  name: string;
  ms: number;
}

export interface TimingSummary {
  name: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Counts and percentiles ONLY — no raw values by construction. */
export interface TelemetrySummary {
  events: { type: PrivacyEventType; count: number }[];
  timings: TimingSummary[];
  /** Bounded-buffer evictions (diagnostic; 0 in normal operation). */
  dropped: { events: number; timings: number };
}

const EVENT_TYPES: readonly PrivacyEventType[] = [
  'DETECTED',
  'SANITIZED',
  'BLOCKED',
  'ALIAS_RESOLVED',
  'TASK_RESULT',
];

const MAX_EVENTS = 1_000;
const MAX_TIMINGS = 1_000;

export interface Telemetry {
  record(event: PrivacyEvent): void;
  timing(name: string, ms: number): void;
  eventCounts(): Record<PrivacyEventType, number>;
  timings(): StageTiming[];
  exportSummary(): TelemetrySummary;
  clear(): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function createTelemetry(): Telemetry {
  const events: PrivacyEvent[] = [];
  const timings: StageTiming[] = [];
  const dropped = { events: 0, timings: 0 };

  return {
    record(event) {
      // Allowlist copy: unknown/extra fields (including any raw value a caller might
      // attach) never enter the log — enforced here, not trusted from callers.
      if (typeof event !== 'object' || event === null) return;
      const type = (event as PrivacyEvent).type;
      if (!EVENT_TYPES.includes(type)) return;
      const clean: PrivacyEvent = { type, timestamp: event.timestamp };
      const category = event.entityCategory;
      if (typeof category === 'string') clean.entityCategory = category;
      const alias = event.alias;
      if (typeof alias === 'string' && alias.length > 0) clean.alias = alias;
      events.push(clean);
      if (events.length > MAX_EVENTS) {
        events.shift();
        dropped.events++;
      }
    },

    timing(name, ms) {
      if (typeof name !== 'string' || name.length === 0) return;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
      timings.push({ name, ms });
      if (timings.length > MAX_TIMINGS) {
        timings.shift();
        dropped.timings++;
      }
    },

    eventCounts() {
      const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<
        PrivacyEventType,
        number
      >;
      for (const event of events) counts[event.type]++;
      return counts;
    },

    timings() {
      return timings.slice();
    },

    exportSummary() {
      const counts = this.eventCounts();
      const byName = new Map<string, number[]>();
      for (const { name, ms } of timings) {
        const list = byName.get(name) ?? [];
        list.push(ms);
        byName.set(name, list);
      }
      const timingSummaries: TimingSummary[] = [...byName.entries()].map(([name, values]) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return {
          name,
          count: sorted.length,
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          maxMs: sorted[sorted.length - 1] ?? 0,
        };
      });
      return {
        events: EVENT_TYPES.map((type) => ({ type, count: counts[type] })),
        timings: timingSummaries,
        dropped: { ...dropped },
      };
    },

    clear() {
      events.length = 0;
      timings.length = 0;
      dropped.events = 0;
      dropped.timings = 0;
    },
  };
}
