import { describe, expect, it, vi } from 'vitest';

// The session wrapper is imported fresh per test file; React components are covered
// by e2e — here we verify the pub-sub contract and value-free pass-through.

describe('telemetry session wrapper', () => {
  it('notifies subscribers on record, timing and clear', async () => {
    const { sessionTelemetry, subscribeToTelemetry } = await import(
      '../../extension/src/sidepanel/telemetry-session'
    );
    const listener = vi.fn();
    const unsubscribe = subscribeToTelemetry(listener);

    sessionTelemetry.record({ type: 'DETECTED', timestamp: 1 });
    sessionTelemetry.timing('scan.detect', 1.5);
    expect(listener).toHaveBeenCalledTimes(2);

    sessionTelemetry.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(sessionTelemetry.eventCounts()['DETECTED']).toBe(0);

    unsubscribe();
    sessionTelemetry.record({ type: 'SANITIZED', timestamp: 2 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('monotonic version advances for useSyncExternalStore snapshots', async () => {
    const { getTelemetryVersion, sessionTelemetry, subscribeToTelemetry } = await import(
      '../../extension/src/sidepanel/telemetry-session'
    );
    const before = getTelemetryVersion();
    const seen: number[] = [];
    const unsubscribe = subscribeToTelemetry(() => seen.push(getTelemetryVersion()));
    sessionTelemetry.record({ type: 'TASK_RESULT', timestamp: 3 });
    unsubscribe();
    expect(getTelemetryVersion()).toBeGreaterThan(before);
    expect(seen.every((version) => version > before)).toBe(true);
  });

  it('exportSummary stays value-free through the wrapper (canary)', async () => {
    const { sessionTelemetry } = await import('../../extension/src/sidepanel/telemetry-session');
    sessionTelemetry.record({
      type: 'DETECTED',
      entityCategory: 'EMAIL',
      timestamp: 4,
    });
    const exported = JSON.stringify(sessionTelemetry.exportSummary());
    expect(exported).not.toContain('CANARY_EMAIL_001@example.test');
    expect(exported).not.toContain('entityCategory');
  });
});
