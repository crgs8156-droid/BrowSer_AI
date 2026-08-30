// M5 — PRIVACY / LEAKAGE TESTS for the sanitization + enforcement layer.
//
// Invariant under test (CLAUDE.md §5 Rule 1/2/4): a raw protected value handed to
// M5 CANNOT appear in the enforcement result, in a log line, or on the network.
// The raw value is recoverable ONLY from the local, in-memory vault, and only via
// its alias — never from the alias directory itself. The source is also scanned
// (comments stripped) to prove it contains no logging, egress, or persistent
// storage. Synthetic canaries only (CLAUDE.md §13/§15).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { enforcePrivacy } from '../../extension/src/sanitizer';
import { createLocalVault } from '../../extension/src/vault';
import type {
  PolicySignals,
  SensitiveEntity,
  VisualPerceptionResult,
} from '../../extension/src/types/contracts';

const CANARY_SECRET = 'CANARY_SECRET_pa55w0rd+7c1e@example.test';
const SANITIZER_SRC = join(process.cwd(), 'extension', 'src', 'sanitizer');
const VAULT_SRC = join(process.cwd(), 'extension', 'src', 'vault');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** Strip comments so the scan checks executable code, not prose that may name an
 *  API purely to document that it is NOT used. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function entity(overrides: Partial<SensitiveEntity> = {}): SensitiveEntity {
  return { id: 'e1', category: 'EMAIL', source: 'DOM', confidence: 1, reasons: ['pattern'], ...overrides };
}

function visualWith(id: string): VisualPerceptionResult {
  return {
    status: 'completed',
    supported: true,
    observations: [
      {
        type: 'visual_observation',
        source: 'vision',
        region: { id, x: 0, y: 0, width: 80, height: 30 },
        observations: ['text_like_content'],
        confidence: 0.9,
        local: true,
      },
    ],
    metrics: { candidatesConsidered: 1, regionsSelected: 1, regionsProcessed: 1, regionsFromCache: 0, durationMs: 5 },
  };
}

/** A spread of inputs exercising every enforcement branch, each carrying the
 *  canary in a place M5 must never expose. */
const CANARY_SIGNALS: PolicySignals[] = [
  { entities: [entity({ category: 'PASSWORD', text: CANARY_SECRET, confidence: 1 })] },
  { entities: [entity({ category: 'EMAIL', text: CANARY_SECRET, confidence: 1 })] },
  { entities: [entity({ category: 'PHONE', text: CANARY_SECRET, confidence: 0.6 })] },
  {
    entities: [
      entity({ category: 'PAYMENT_CARD' as SensitiveEntity['category'], text: CANARY_SECRET, confidence: 1 }),
    ],
  },
  { entities: [{ reasons: [CANARY_SECRET] } as unknown as SensitiveEntity] }, // malformed
  { entities: [entity({ text: CANARY_SECRET })], restricted: true },
  { entities: [entity({ text: CANARY_SECRET })], visual: visualWith('r1') },
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

describe('the raw canary never crosses the M5 boundary', () => {
  it('no enforcement result serializes the canary, across every branch', async () => {
    for (const signals of CANARY_SIGNALS) {
      const vault = createLocalVault();
      const result = await enforcePrivacy({
        signals,
        pageText: `context ${CANARY_SECRET} context`,
        sessionId: 's',
        vault,
        now: () => 1,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(CANARY_SECRET);
      expect(serialized).not.toContain('pa55w0rd');
    }
  });

  it('the canary is recoverable only from the local vault, never from the alias directory', async () => {
    const vault = createLocalVault();
    const result = await enforcePrivacy({
      signals: { entities: [entity({ id: 'e1', category: 'EMAIL', text: CANARY_SECRET, confidence: 1 })] },
      pageText: CANARY_SECRET,
      sessionId: 's',
      vault,
      now: () => 1,
    });
    expect(JSON.stringify(result.aliases)).not.toContain(CANARY_SECRET);
    expect(await vault.resolve('USER_EMAIL_1')).toBe(CANARY_SECRET);
    // The mapping is session-scoped and wiped on clear.
    await vault.clearSession('s');
    expect(await vault.resolve('USER_EMAIL_1')).toBeUndefined();
  });
});

describe('M5 performs no logging or network I/O', () => {
  it('writes nothing to the console for any input, including malformed and restricted', async () => {
    for (const signals of CANARY_SIGNALS) {
      const vault = createLocalVault();
      await enforcePrivacy({ signals, pageText: CANARY_SECRET, sessionId: 's', vault, now: () => 1 });
    }
    expect(consoleOutput()).toBe('');
  });

  it('opens no network channel', async () => {
    for (const signals of CANARY_SIGNALS) {
      const vault = createLocalVault();
      await enforcePrivacy({ signals, pageText: CANARY_SECRET, sessionId: 's', vault, now: () => 1 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });
});

describe('the M5 source contains no logging, egress, or persistent storage', () => {
  it('has no console statement in the sanitizer or vault sources', () => {
    const files = [...sourceFiles(SANITIZER_SRC), ...sourceFiles(VAULT_SRC)];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) =>
      /\bconsole\s*\.\s*(log|info|warn|error|debug|trace)\s*\(/.test(codeOnly(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('has no network or persistent-storage call in the sanitizer or vault sources', () => {
    const files = [...sourceFiles(SANITIZER_SRC), ...sourceFiles(VAULT_SRC)];
    const offenders = files.filter((file) =>
      /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB)\b|chrome\s*\.\s*storage/.test(
        codeOnly(readFileSync(file, 'utf8')),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
