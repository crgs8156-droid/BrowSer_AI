// M4 — PRIVACY / LEAKAGE TESTS for the policy layer.
//
// Invariant under test: a raw protected value handed to the policy engine (via
// `SensitiveEntity.text`) CANNOT flow into the decision, into a log line, or to
// the network. The engine is a pure reducer, so the guarantee is structural —
// these tests prove it holds across clean, sensitive, malformed and restricted
// inputs, and that the source contains no logging or egress at all.
//
// Synthetic canaries only (CONTRIBUTING.md §13/§15). If a canary escapes, these fail.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decidePolicy, decidePolicyReport } from '../../extension/src/policy';
import type { PolicySignals, SensitiveEntity } from '../../extension/src/types/contracts';

/** Synthetic canary — a raw secret value that must never leave the local vault. */
const CANARY_SECRET = 'CANARY_SECRET_pa55w0rd+7c1e@example.test';

const POLICY_SRC = join(process.cwd(), 'extension', 'src', 'policy');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

function entity(overrides: Partial<SensitiveEntity> = {}): SensitiveEntity {
  return {
    id: 'e1',
    category: 'EMAIL',
    source: 'DOM',
    confidence: 1,
    reasons: ['pattern'],
    ...overrides,
  };
}

/** A spread of inputs that exercise every decision branch. Each carries the
 *  canary in a place the engine must never read. */
const CANARY_INPUTS: PolicySignals[] = [
  { entities: [entity({ category: 'PASSWORD', text: CANARY_SECRET, confidence: 1 })] },
  { entities: [entity({ category: 'EMAIL', text: CANARY_SECRET, confidence: 1 })] },
  { entities: [entity({ category: 'PHONE', text: CANARY_SECRET, confidence: 0.6 })] },
  {
    entities: [entity({ category: 'PAYMENT_CARD' as SensitiveEntity['category'], text: CANARY_SECRET, confidence: 1 })],
  },
  { entities: [{ reasons: [CANARY_SECRET] } as unknown as SensitiveEntity] }, // malformed
  { entities: [entity({ text: CANARY_SECRET })], restricted: true },
];

let consoleSpies: ReturnType<typeof vi.spyOn>[];
let fetchSpy: ReturnType<typeof vi.fn>;
let sendBeaconSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  fetchSpy = vi.fn(() => Promise.reject(new Error('network blocked in test')));
  sendBeaconSpy = vi.fn(() => true);
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('navigator', { sendBeacon: sendBeaconSpy, userAgent: 'test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const spy of consoleSpies) spy.mockRestore();
});

function consoleOutput(): string {
  return consoleSpies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map((arg: unknown) => String(arg)).join(' '))
    .join('\n');
}

describe('the raw protected value never reaches the decision', () => {
  it('no decision serializes the canary, across every branch', () => {
    for (const input of CANARY_INPUTS) {
      const serialized = JSON.stringify(decidePolicy(input));
      expect(serialized).not.toContain(CANARY_SECRET);
      expect(serialized).not.toContain('pa55w0rd');
    }
  });

  it('the explanation is built from categories and counts only', () => {
    const d = decidePolicy({
      entities: [
        entity({ id: 'a', category: 'EMAIL', text: CANARY_SECRET, confidence: 1 }),
        entity({ id: 'b', category: 'PASSWORD', text: CANARY_SECRET, confidence: 1 }),
      ],
    });
    expect(d.explanation).not.toContain(CANARY_SECRET);
    expect(d.explanation).toMatch(/credential|contact|sensitive/i);
  });

  it('the decision object exposes only the documented keys', () => {
    const d = decidePolicy({ entities: [entity({ text: CANARY_SECRET })] });
    expect(Object.keys(d).sort()).toEqual([
      'action',
      'confidence',
      'explanation',
      'local',
      'reasonCode',
      'severity',
      'signals',
    ]);
    expect(d).not.toHaveProperty('text');
    expect(d).not.toHaveProperty('entities');
    expect(d).not.toHaveProperty('screenshot');
  });
});

describe('the policy engine performs no I/O', () => {
  it('writes nothing to the console for any input, including malformed', () => {
    for (const input of CANARY_INPUTS) decidePolicy(input);
    decidePolicy(null as unknown as PolicySignals);
    decidePolicy({});
    expect(consoleOutput()).toBe('');
  });

  it('opens no network channel', () => {
    for (const input of CANARY_INPUTS) decidePolicy(input);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });
});

describe('the raw protected value never reaches the multi-finding report', () => {
  it('no report — overall or per-finding — serializes the canary, across every branch', () => {
    for (const input of CANARY_INPUTS) {
      const serialized = JSON.stringify(decidePolicyReport(input));
      expect(serialized).not.toContain(CANARY_SECRET);
      expect(serialized).not.toContain('pa55w0rd');
    }
  });

  it('every finding exposes only its allowed keys and no raw value', () => {
    const report = decidePolicyReport({
      entities: [
        entity({ id: 'a', category: 'EMAIL', text: CANARY_SECRET, elementId: 'el-a', confidence: 1 }),
        entity({ id: 'b', category: 'PASSWORD', text: CANARY_SECRET, bbox: [1, 2, 3, 4], confidence: 1 }),
      ],
    });
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(Object.keys(finding).sort()).toEqual([
        'action',
        'confidence',
        'reasonCode',
        'ref',
        'severity',
        'signal',
      ]);
      expect(finding).not.toHaveProperty('text');
      expect(finding.ref).not.toHaveProperty('text');
      expect(JSON.stringify(finding)).not.toContain(CANARY_SECRET);
    }
  });

  it('building the report writes nothing to the console and opens no network channel', () => {
    for (const input of CANARY_INPUTS) decidePolicyReport(input);
    decidePolicyReport(null as unknown as PolicySignals);
    expect(consoleOutput()).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });
});

describe('the policy source contains no logging or egress', () => {
  it('has no console statement anywhere in extension/src/policy', () => {
    const files = sourceFiles(POLICY_SRC);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('has no network or storage call anywhere in extension/src/policy', () => {
    const files = sourceFiles(POLICY_SRC);
    const offenders = files.filter((file) =>
      /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB)\b/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
