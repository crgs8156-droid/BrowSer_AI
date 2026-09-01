import { describe, expect, it } from 'vitest';
import { createTelemetry } from '../../extension/src/telemetry';
import type { PrivacyEvent } from '../../extension/src/types/contracts';

const CANARY = 'CANARY_EMAIL_001@example.test';

function event(partial: Partial<PrivacyEvent>): PrivacyEvent {
  return { type: 'DETECTED', timestamp: 1_000, ...partial };
}

describe('telemetry (value-free audit log)', () => {
  it('counts events by type', () => {
    const telemetry = createTelemetry();
    telemetry.record(event({ type: 'DETECTED' }));
    telemetry.record(event({ type: 'DETECTED' }));
    telemetry.record(event({ type: 'ALIAS_RESOLVED', alias: 'USER_EMAIL_1' }));
    telemetry.record(event({ type: 'BLOCKED' }));
    const counts = telemetry.eventCounts();
    expect(counts['DETECTED']).toBe(2);
    expect(counts['ALIAS_RESOLVED']).toBe(1);
    expect(counts['BLOCKED']).toBe(1);
    expect(counts['SANITIZED']).toBe(0);
    expect(counts['TASK_RESULT']).toBe(0);
  });

  it('drops unknown fields — a caller cannot smuggle raw values into the log', () => {
    const telemetry = createTelemetry();
    const smuggled = event({ type: 'DETECTED', entityCategory: 'EMAIL' }) as PrivacyEvent & {
      raw?: string;
    };
    smuggled.raw = CANARY;
    telemetry.record(smuggled);
    const exported = JSON.stringify(telemetry.exportSummary());
    expect(exported).not.toContain(CANARY);
    // The summary never contains event payloads at all — only counts.
    expect(exported).not.toContain('entityCategory');
  });

  it('ignores unknown event types and malformed input', () => {
    const telemetry = createTelemetry();
    telemetry.record(event({ type: 'NOT_A_TYPE' as never }));
    telemetry.record(null as never);
    telemetry.record(undefined as never);
    telemetry.record('email@example.test' as never);
    expect(telemetry.eventCounts()['DETECTED']).toBe(0);
  });

  it('computes timing percentiles', () => {
    const telemetry = createTelemetry();
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      telemetry.timing('enforce', ms);
    }
    const summary = telemetry.exportSummary();
    const enforce = summary.timings.find((row) => row.name === 'enforce');
    expect(enforce).toBeDefined();
    expect(enforce?.count).toBe(10);
    expect(enforce?.p50Ms).toBe(50);
    expect(enforce?.p95Ms).toBe(100);
    expect(enforce?.maxMs).toBe(100);
  });

  it('ignores malformed timings', () => {
    const telemetry = createTelemetry();
    telemetry.timing('', 5);
    telemetry.timing('scan', Number.NaN);
    telemetry.timing('scan', -1);
    telemetry.timing('scan', Number.POSITIVE_INFINITY);
    expect(telemetry.timings()).toHaveLength(0);
  });

  it('evicts oldest entries when buffers overflow (bounded memory)', () => {
    const telemetry = createTelemetry();
    for (let index = 0; index < 1_050; index++) {
      telemetry.timing('scan', index);
      telemetry.record(event({ type: 'DETECTED' }));
    }
    expect(telemetry.timings()).toHaveLength(1_000);
    const summary = telemetry.exportSummary();
    expect(summary.dropped.timings).toBe(50);
    expect(summary.dropped.events).toBe(50);
  });

  it('clear() resets everything', () => {
    const telemetry = createTelemetry();
    telemetry.record(event({}));
    telemetry.timing('scan', 5);
    telemetry.clear();
    const summary = telemetry.exportSummary();
    expect(summary.events.every((row) => row.count === 0)).toBe(true);
    expect(summary.timings).toHaveLength(0);
  });
});
