// M5 — enforcePrivacy behavioral tests.
//
// Drives the REAL enforcement orchestrator (which internally calls the REAL M4
// `decidePolicyReport`) and asserts on what it actually DID to each finding —
// not merely that it ran. Covers the 16 required M5 scenarios, each labelled.
// Every value is synthetic (CONTRIBUTING.md §13/§15).

import { describe, expect, it } from 'vitest';
import { enforcePrivacy } from '../../extension/src/sanitizer';
import { createLocalVault } from '../../extension/src/vault';
import { decidePolicyReport } from '../../extension/src/policy';
import type {
  PolicySignals,
  SensitiveEntity,
  VisualObservation,
  VisualPerceptionResult,
} from '../../extension/src/types/contracts';

function entity(overrides: Partial<SensitiveEntity> = {}): SensitiveEntity {
  return { id: 'e1', category: 'EMAIL', source: 'DOM', confidence: 1, reasons: ['pattern'], ...overrides };
}

interface Region {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
}

function visual(regions: Region[]): VisualPerceptionResult {
  const observations: VisualObservation[] = regions.map((r) => ({
    type: 'visual_observation',
    source: 'vision',
    region: { id: r.id, x: r.x, y: r.y, width: r.width, height: r.height },
    observations: ['text_like_content'],
    confidence: r.confidence ?? 0.9,
    local: true,
  }));
  return {
    status: 'completed',
    supported: true,
    observations,
    metrics: {
      candidatesConsidered: regions.length,
      regionsSelected: regions.length,
      regionsProcessed: regions.length,
      regionsFromCache: 0,
      durationMs: 5,
    },
  };
}

async function enforce(signals: PolicySignals, pageText = '') {
  const vault = createLocalVault();
  const result = await enforcePrivacy({ signals, pageText, sessionId: 's1', vault, now: () => 1000 });
  return { result, vault };
}

describe('enforcePrivacy — the 16 required M5 scenarios', () => {
  it('case 1 — a page with no sensitive content is passed through and certified', async () => {
    const { result } = await enforce({ entities: [] }, 'Just a public article about weather.');
    expect(result.findings).toHaveLength(0);
    expect(result.aliases).toHaveLength(0);
    expect(result.visualMasks).toHaveLength(0);
    expect(result.sanitizedText).toBe('Just a public article about weather.');
    expect(result.enforced).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.restricted).toBe(false);
  });

  it('case 2 — a single sensitive text value is aliased out and stored locally', async () => {
    const { result, vault } = await enforce(
      { entities: [entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' })] },
      'Write to alice@corp.test today.',
    );
    expect(result.sanitizedText).toBe('Write to USER_EMAIL_1 today.');
    expect(result.sanitizedText).not.toContain('alice@corp.test');
    expect(result.aliases).toEqual([{ alias: 'USER_EMAIL_1', category: 'EMAIL' }]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.disposition).toBe('aliased');
    expect(result.findings[0]!.alias).toBe('USER_EMAIL_1');
    expect(result.enforced).toBe(true);
    expect(await vault.resolve('USER_EMAIL_1')).toBe('alice@corp.test');
  });

  it('case 3 — multiple sensitive text values are all aliased', async () => {
    const { result } = await enforce(
      {
        entities: [
          entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' }),
          entity({
            id: 'e2',
            category: 'PHONE_NUMBER' as SensitiveEntity['category'],
            text: '+1-202-555-0143',
            confidence: 1,
          }),
        ],
      },
      'Email alice@corp.test or call +1-202-555-0143.',
    );
    expect(result.sanitizedText).not.toContain('alice@corp.test');
    expect(result.sanitizedText).not.toContain('+1-202-555-0143');
    expect(result.aliases).toEqual([
      { alias: 'USER_EMAIL_1', category: 'EMAIL' },
      { alias: 'USER_PHONE_1', category: 'PHONE' },
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.disposition === 'aliased')).toBe(true);
  });

  it('case 4 — a single visual finding becomes a mask directive', async () => {
    const { result } = await enforce({ visual: visual([{ id: 'r1', x: 0, y: 0, width: 100, height: 40 }]) }, 'page');
    expect(result.visualMasks).toHaveLength(1);
    expect(result.visualMasks[0]!.bbox).toEqual([0, 0, 100, 40]);
    expect(result.visualMasks[0]!.findingIds).toEqual(['r1']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.disposition).toBe('masked');
    expect(result.enforced).toBe(true);
  });

  it('case 5 — multiple visual findings each yield a directive', async () => {
    const { result } = await enforce(
      {
        visual: visual([
          { id: 'r1', x: 0, y: 0, width: 50, height: 20 },
          { id: 'r2', x: 0, y: 200, width: 50, height: 20 },
        ]),
      },
      'page',
    );
    expect(result.visualMasks).toHaveLength(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.disposition === 'masked')).toBe(true);
  });

  it('case 6 — text and visual findings are handled together', async () => {
    const { result } = await enforce(
      {
        entities: [entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' })],
        visual: visual([{ id: 'r1', x: 10, y: 10, width: 80, height: 30 }]),
      },
      'Mail alice@corp.test.',
    );
    expect(result.aliases).toHaveLength(1);
    expect(result.visualMasks).toHaveLength(1);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.disposition).sort()).toEqual(['aliased', 'masked']);
    expect(result.sanitizedText).not.toContain('alice@corp.test');
    expect(result.enforced).toBe(true);
  });

  it('case 7 — findings at different positions in the text are all redacted', async () => {
    const { result } = await enforce(
      {
        entities: [
          entity({ id: 'e1', category: 'EMAIL', text: 'first@corp.test' }),
          entity({ id: 'e2', category: 'EMAIL', text: 'second@corp.test' }),
        ],
      },
      'Start first@corp.test middle second@corp.test end',
    );
    expect(result.sanitizedText).toBe('Start USER_EMAIL_1 middle USER_EMAIL_2 end');
    expect(result.sanitizedText).not.toContain('first@corp.test');
    expect(result.sanitizedText).not.toContain('second@corp.test');
  });

  it('case 8 — findings in far-apart regions of a long page stay distinct and ordered', async () => {
    const { result } = await enforce(
      {
        visual: visual([
          { id: 'bottom', x: 0, y: 6000, width: 50, height: 20 },
          { id: 'top', x: 0, y: 0, width: 50, height: 20 },
        ]),
      },
      'page',
    );
    expect(result.visualMasks).toHaveLength(2);
    expect(result.visualMasks[0]!.findingIds).toEqual(['top']);
    expect(result.visualMasks[1]!.findingIds).toEqual(['bottom']);
  });

  it('case 9 — overlapping regions merge so the union stays protected; neither dropped', async () => {
    const { result } = await enforce(
      {
        visual: visual([
          { id: 'r1', x: 0, y: 0, width: 60, height: 60 },
          { id: 'r2', x: 40, y: 40, width: 60, height: 60 },
        ]),
      },
      'page',
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.disposition === 'masked')).toBe(true);
    expect(result.visualMasks).toHaveLength(1);
    expect(result.visualMasks[0]!.bbox).toEqual([0, 0, 100, 100]);
    expect(result.visualMasks[0]!.findingIds).toEqual(['r1', 'r2']);
  });

  it('case 10 — mixed severities/actions each get the right disposition; a credential blocks', async () => {
    const { result, vault } = await enforce(
      {
        entities: [
          entity({ id: 'pw', category: 'PASSWORD', text: 'Sup3r$ecret!', confidence: 1 }),
          entity({ id: 'em', category: 'EMAIL', text: 'alice@corp.test', confidence: 1 }),
          entity({ id: 'ph', category: 'PHONE', text: '202-555-0143', confidence: 0.6 }),
        ],
        visual: visual([{ id: 'r1', x: 0, y: 0, width: 40, height: 40 }]),
      },
      'pw Sup3r$ecret! em alice@corp.test ph 202-555-0143',
    );
    expect(result.blocked).toBe(true);
    const byRef: Record<string, string> = {};
    for (const f of result.findings) if (f.ref.findingId) byRef[f.ref.findingId] = f.disposition;
    expect(byRef['pw']).toBe('aliased');
    expect(byRef['em']).toBe('aliased');
    expect(byRef['ph']).toBe('aliased');
    expect(byRef['r1']).toBe('masked');
    expect(result.sanitizedText).not.toContain('Sup3r$ecret!');
    expect(result.sanitizedText).not.toContain('alice@corp.test');
    expect(result.sanitizedText).not.toContain('202-555-0143');
    const pwFinding = result.findings.find((f) => f.ref.findingId === 'pw')!;
    expect(await vault.resolve(pwFinding.alias!)).toBe('Sup3r$ecret!');
  });

  it('case 11 — malformed findings are flagged, never dropped, and block certification', async () => {
    const { result } = await enforce(
      {
        entities: [
          { reasons: ['x'] } as unknown as SensitiveEntity, // malformed: no id/category/text
          entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' }),
        ],
      },
      'alice@corp.test',
    );
    expect(result.findings).toHaveLength(2);
    const dispositions = result.findings.map((f) => f.disposition);
    expect(dispositions).toContain('flagged');
    expect(dispositions).toContain('aliased');
    expect(result.enforced).toBe(false);
  });

  it('case 12a — a restricted page is reported restricted and not certified', async () => {
    const { result } = await enforce({ entities: [], restricted: true }, 'blocked page');
    expect(result.restricted).toBe(true);
    expect(result.enforced).toBe(false);
  });

  it('case 12b — an inaccessible finding (no value, no region) fails closed', async () => {
    const { result } = await enforce(
      { entities: [entity({ id: 'ghost', category: 'EMAIL', confidence: 1 })] },
      'no value present here',
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.disposition).toBe('inaccessible');
    expect(result.enforced).toBe(false);
    expect(result.aliases).toHaveLength(0);
  });

  it('case 13/14 — the raw canary never appears in the result; the alias does; value stays in the vault', async () => {
    const CANARY = 'CANARY_enf_pa55w0rd+7c1e@example.test';
    const { result, vault } = await enforce(
      { entities: [entity({ id: 'e1', category: 'EMAIL', text: CANARY, confidence: 1 })] },
      `Reach me at ${CANARY} anytime.`,
    );
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain('pa55w0rd');
    expect(result.sanitizedText).not.toContain(CANARY);
    expect(result.sanitizedText).toContain('USER_EMAIL_1');
    expect(await vault.resolve('USER_EMAIL_1')).toBe(CANARY);
  });

  it('case 15 — non-sensitive content remains available after sanitization', async () => {
    const { result } = await enforce(
      { entities: [entity({ id: 'e1', category: 'EMAIL', text: 'alice@corp.test' })] },
      'Contact alice@corp.test for the Q3 report due Tuesday.',
    );
    expect(result.sanitizedText).toContain('Contact');
    expect(result.sanitizedText).toContain('Q3 report');
    expect(result.sanitizedText).toContain('Tuesday');
    expect(result.sanitizedText).not.toContain('alice@corp.test');
  });

  it('case 16 — every M4 finding is accounted for; none is silently dropped', async () => {
    const signals: PolicySignals = {
      entities: [
        entity({ id: 'em1', category: 'EMAIL', text: 'a@corp.test', confidence: 1 }),
        entity({ id: 'em2', category: 'EMAIL', text: 'b@corp.test', confidence: 1 }),
        entity({ id: 'ph1', category: 'PHONE', text: '202-555-0143', confidence: 1 }),
        entity({ id: 'ghost', category: 'ID', confidence: 1 }), // no value/region → inaccessible
        { reasons: ['x'] } as unknown as SensitiveEntity, // malformed → flagged
      ],
      visual: visual([{ id: 'r1', x: 0, y: 0, width: 30, height: 30 }]),
    };
    const report = decidePolicyReport(signals);
    const { result } = await enforce(signals, 'a@corp.test b@corp.test 202-555-0143');
    expect(report.findings.length).toBeGreaterThan(1);
    expect(result.findings).toHaveLength(report.findings.length);
    for (const f of result.findings) {
      expect(['aliased', 'masked', 'flagged', 'inaccessible']).toContain(f.disposition);
    }
    const kinds = new Set(result.findings.map((f) => f.disposition));
    expect(kinds.has('aliased')).toBe(true);
    expect(kinds.has('masked')).toBe(true);
    expect(kinds.has('flagged')).toBe(true);
    expect(kinds.has('inaccessible')).toBe(true);
  });
});
