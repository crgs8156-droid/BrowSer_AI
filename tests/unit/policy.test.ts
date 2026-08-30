// M4 — Local privacy decision / policy layer: unit tests.
//
// Each test drives the REAL `decidePolicy` reducer with realistic M0–M3 signal
// shapes and asserts on the derived decision — not on hard-coded constants.
// The 10 required scenarios from the M4 brief are covered and labelled.

import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_CONFIDENCE,
  POSSIBLE_CONFIDENCE,
  VISUAL_TEXT_LIKE_CONFIDENCE,
  decidePolicy,
  decidePolicyReport,
} from '../../extension/src/policy';
import type {
  SensitiveEntity,
  VisualObservation,
  VisualPerceptionResult,
} from '../../extension/src/types/contracts';

// --- builders -------------------------------------------------------------

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

function completedVisual(observations: VisualObservation[]): VisualPerceptionResult {
  return {
    status: 'completed',
    supported: true,
    observations,
    metrics: {
      candidatesConsidered: 1,
      regionsSelected: 1,
      regionsProcessed: 1,
      regionsFromCache: 0,
      durationMs: 5,
    },
  };
}

function textLikeObservation(confidence: number): VisualObservation {
  return {
    type: 'visual_observation',
    source: 'vision',
    region: { id: 'r1', x: 0, y: 0, width: 100, height: 40 },
    observations: ['text_like_content'],
    confidence,
    local: true,
  };
}

// --- 1. clean input → safe -------------------------------------------------

describe('decidePolicy — clean input yields a safe decision', () => {
  it('ALLOWs when detection ran and found nothing sensitive', () => {
    const d = decidePolicy({ entities: [] });
    expect(d.action).toBe('ALLOW');
    expect(d.severity).toBe('none');
    expect(d.reasonCode).toBe('NO_SENSITIVE_DATA');
    expect(d.signals).toEqual([]);
    expect(d.local).toBe(true);
  });

  it('treats ordinary DOM text (UNCLASSIFIED) as benign, still ALLOW', () => {
    // The DOM collector tags every visible text node UNCLASSIFIED; that is not
    // a sensitivity hit and must not raise the action.
    const entities = [
      entity({ id: 'a', category: 'UNCLASSIFIED' as SensitiveEntity['category'], confidence: 1 }),
      entity({ id: 'b', category: 'UNCLASSIFIED' as SensitiveEntity['category'], confidence: 1 }),
    ];
    const d = decidePolicy({ entities });
    expect(d.action).toBe('ALLOW');
    expect(d.reasonCode).toBe('NO_SENSITIVE_DATA');
  });
});

// --- 2. high-confidence sensitive → protective ----------------------------

describe('decidePolicy — high-confidence sensitive triggers protection', () => {
  it('SANITIZEs a confirmed email (medium severity, high confidence)', () => {
    const d = decidePolicy({ entities: [entity({ category: 'EMAIL', confidence: 1 })] });
    expect(d.action).toBe('SANITIZE');
    expect(d.reasonCode).toBe('CONFIRMED_SENSITIVE_DATA');
    expect(d.severity).toBe('medium');
    expect(d.signals).toContain('contact');
    expect(d.confidence).toBeGreaterThanOrEqual(CONFIRMED_CONFIDENCE);
  });

  it('SANITIZEs a confirmed payment card emitted as PAYMENT_CARD (M2 string)', () => {
    // M2 emits PAYMENT_CARD, not the declared PAYMENT; the map tolerates both.
    const d = decidePolicy({
      entities: [entity({ category: 'PAYMENT_CARD' as SensitiveEntity['category'], confidence: 1 })],
    });
    expect(d.action).toBe('SANITIZE');
    expect(d.severity).toBe('high');
    expect(d.signals).toContain('payment');
  });
});

// --- 3. low-confidence → warning / uncertainty ----------------------------

describe('decidePolicy — low-confidence signal warns rather than blocks', () => {
  it('WARNs on a possible (sub-confirmed) contact hit', () => {
    const conf = (POSSIBLE_CONFIDENCE + CONFIRMED_CONFIDENCE) / 2; // clearly "possible"
    const d = decidePolicy({ entities: [entity({ category: 'PHONE', confidence: conf })] });
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('POSSIBLE_SENSITIVE_DATA');
    expect(d.confidence).toBeLessThan(CONFIRMED_CONFIDENCE);
  });
});

// --- 4. multiple signals combine ------------------------------------------

describe('decidePolicy — multiple signals combine to the strongest action', () => {
  it('a confirmed email + a confirmed credential → BLOCK, both signals listed', () => {
    const d = decidePolicy({
      entities: [
        entity({ id: 'mail', category: 'EMAIL', confidence: 1 }),
        entity({ id: 'cred', category: 'CREDENTIAL' as SensitiveEntity['category'], confidence: 1 }),
      ],
    });
    expect(d.action).toBe('BLOCK');
    expect(d.severity).toBe('critical');
    expect(d.signals).toEqual(expect.arrayContaining(['contact', 'credential']));
  });

  it('order of entities does not change the decision (deterministic)', () => {
    const a = decidePolicy({
      entities: [
        entity({ id: '1', category: 'EMAIL', confidence: 1 }),
        entity({ id: '2', category: 'PASSWORD', confidence: 1 }),
      ],
    });
    const b = decidePolicy({
      entities: [
        entity({ id: '2', category: 'PASSWORD', confidence: 1 }),
        entity({ id: '1', category: 'EMAIL', confidence: 1 }),
      ],
    });
    expect(a).toEqual(b);
  });
});

// --- 5. missing signal → fail-safe ----------------------------------------

describe('decidePolicy — a missing signal fails safe, never ALLOW', () => {
  it('WARNs with SIGNAL_UNAVAILABLE when no signals are provided at all', () => {
    const d = decidePolicy({});
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('SIGNAL_UNAVAILABLE');
    expect(d.action).not.toBe('ALLOW');
  });

  it('distinguishes "entities undefined" (unknown → WARN) from "entities []" (ran → ALLOW)', () => {
    expect(decidePolicy({ visual: completedVisual([]) }).action).toBe('WARN');
    expect(decidePolicy({ entities: [] }).action).toBe('ALLOW');
  });
});

// --- 6. malformed signal → fail-safe --------------------------------------

describe('decidePolicy — a malformed signal fails safe', () => {
  it('WARNs (MALFORMED_SIGNAL) when the whole input is not an object', () => {
    const d = decidePolicy(null as unknown as Parameters<typeof decidePolicy>[0]);
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('MALFORMED_SIGNAL');
  });

  it('WARNs when an entity in the array is malformed', () => {
    const d = decidePolicy({
      entities: [{ nonsense: true } as unknown as SensitiveEntity],
    });
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('MALFORMED_SIGNAL');
  });

  it('a malformed entity never lowers a stronger real action', () => {
    const d = decidePolicy({
      entities: [
        entity({ category: 'PASSWORD', confidence: 1 }),
        { junk: 1 } as unknown as SensitiveEntity,
      ],
    });
    expect(d.action).toBe('BLOCK'); // credential still wins
  });
});

// --- 7. critical credential → strongest action ----------------------------

describe('decidePolicy — a critical credential gets the strongest action', () => {
  it('BLOCKs a confirmed PASSWORD', () => {
    const d = decidePolicy({ entities: [entity({ category: 'PASSWORD', confidence: 1 })] });
    expect(d.action).toBe('BLOCK');
    expect(d.reasonCode).toBe('CRITICAL_CREDENTIAL');
    expect(d.severity).toBe('critical');
  });

  it('BLOCKs a confirmed OTP', () => {
    const d = decidePolicy({ entities: [entity({ category: 'OTP', confidence: 1 })] });
    expect(d.action).toBe('BLOCK');
    expect(d.severity).toBe('critical');
  });
});

// --- 8. restricted / unavailable context → safe handling ------------------

describe('decidePolicy — restricted context is handled safely', () => {
  it('a restricted page prevents ALLOW even with no entities', () => {
    const d = decidePolicy({ entities: [], restricted: true });
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('RESTRICTED_CONTEXT');
    expect(d.signals).toContain('restricted_page');
  });

  it("M3 status 'restricted_page' is treated as restricted", () => {
    const restrictedVisual: VisualPerceptionResult = {
      status: 'restricted_page',
      supported: false,
      observations: [],
      metrics: {
        candidatesConsidered: 0,
        regionsSelected: 0,
        regionsProcessed: 0,
        regionsFromCache: 0,
        durationMs: 0,
      },
    };
    const d = decidePolicy({ entities: [], visual: restrictedVisual });
    expect(d.action).toBe('WARN');
    expect(d.signals).toContain('restricted_page');
  });

  it('confident visual text-like content yields VISUAL_UNCERTAINTY, not a false ALLOW', () => {
    const d = decidePolicy({
      entities: [],
      visual: completedVisual([textLikeObservation(VISUAL_TEXT_LIKE_CONFIDENCE + 0.1)]),
    });
    expect(d.action).toBe('WARN');
    expect(d.reasonCode).toBe('VISUAL_UNCERTAINTY');
    expect(d.signals).toEqual(expect.arrayContaining(['visual_uncertain', 'visual_text_like']));
  });

  it('a completed-but-empty visual result does not by itself force a warning', () => {
    // entities ran clean AND visual completed with no text-like content → ALLOW.
    const d = decidePolicy({ entities: [], visual: completedVisual([]) });
    expect(d.action).toBe('ALLOW');
  });
});

// --- 9. no raw sensitive content in decision / log output -----------------

describe('decidePolicy — never surfaces raw sensitive content', () => {
  it('does not echo entity.text anywhere in the decision', () => {
    const secret = 'canary.secret+9f2a@example.test';
    const d = decidePolicy({
      entities: [entity({ category: 'EMAIL', text: secret, confidence: 1 })],
    });
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('9f2a');
    // The explanation is category/count only.
    expect(d.explanation).not.toContain(secret);
    expect(d.signals).toContain('contact');
  });
});

// --- 10. M0–M3 behaviour unchanged ----------------------------------------

describe('decidePolicy — is a pure consumer (M0–M3 behaviour unchanged)', () => {
  it('never mutates the signals object it is given', () => {
    const entities = [entity({ category: 'EMAIL', confidence: 1 })];
    const visual = completedVisual([textLikeObservation(0.9)]);
    const input = { entities, restricted: false, visual };
    const snapshot = JSON.stringify(input);
    decidePolicy(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(entities).toHaveLength(1);
  });

  it('is synchronous and returns a plain object (no promise, no I/O)', () => {
    const d = decidePolicy({ entities: [] });
    expect(d).not.toBeInstanceOf(Promise);
    expect(typeof d).toBe('object');
    expect(d.local).toBe(true);
  });
});

// ==========================================================================
// decidePolicyReport — per-finding (multi-region) decisions.
//
// The brief requires M4 to preserve a decision for EVERY applicable
// finding/region (not just the strongest one), with the location metadata a
// downstream sanitizer needs, and never the raw value.
// ==========================================================================

describe('decidePolicyReport — page rollup stays consistent with decidePolicy', () => {
  it('report.overall equals the standalone page-level decision', () => {
    const signals = { entities: [entity({ category: 'EMAIL', confidence: 1 })] };
    expect(decidePolicyReport(signals).overall).toEqual(decidePolicy(signals));
  });

  it('clean input has no findings and ALLOWs', () => {
    const r = decidePolicyReport({ entities: [] });
    expect(r.overall.action).toBe('ALLOW');
    expect(r.findings).toEqual([]);
  });

  it('a restricted page is page-level only — no per-region finding', () => {
    const r = decidePolicyReport({ entities: [], restricted: true });
    expect(r.overall.reasonCode).toBe('RESTRICTED_CONTEXT');
    expect(r.findings).toEqual([]);
  });
});

describe('decidePolicyReport — a sensitive visual/image region', () => {
  it('preserves source and bbox for a VISION-sourced sensitive finding', () => {
    const r = decidePolicyReport({
      entities: [
        entity({ id: 'img1', category: 'ID', source: 'VISION', bbox: [10, 20, 100, 40], confidence: 1 }),
      ],
    });
    expect(r.overall.action).toBe('SANITIZE'); // ID = high, confirmed
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.ref.source).toBe('VISION');
    expect(f.ref.bbox).toEqual([10, 20, 100, 40]);
    expect(f.ref.findingId).toBe('img1');
    expect(f.action).toBe('SANITIZE');
    expect(f.signal).toBe('identity');
  });

  it('normalizes an {x,y,width,height} bbox object (M2/M3 shape drift) to a tuple', () => {
    const bboxObject = { x: 5, y: 6, width: 7, height: 8 } as unknown as [number, number, number, number];
    const r = decidePolicyReport({
      entities: [entity({ id: 'obj', category: 'EMAIL', source: 'OCR', bbox: bboxObject, confidence: 1 })],
    });
    expect(r.findings[0]!.ref.bbox).toEqual([5, 6, 7, 8]);
    expect(r.findings[0]!.ref.source).toBe('OCR');
  });
});

describe('decidePolicyReport — MULTIPLE sensitive regions on one page', () => {
  it('preserves a decision for ALL four findings (text A/D + visual B/C)', () => {
    const r = decidePolicyReport({
      entities: [
        entity({ id: 'A', category: 'EMAIL', source: 'DOM', elementId: 'el-a', confidence: 1 }),
        entity({ id: 'B', category: 'ID', source: 'VISION', bbox: [0, 0, 50, 50], confidence: 1 }),
        entity({
          id: 'C',
          category: 'PAYMENT_CARD' as SensitiveEntity['category'],
          source: 'VISION',
          bbox: [60, 0, 50, 50],
          confidence: 1,
        }),
        entity({ id: 'D', category: 'PHONE', source: 'DOM', elementId: 'el-d', confidence: 1 }),
      ],
    });
    expect(r.findings).toHaveLength(4);
    expect(r.findings.map((f) => f.ref.findingId).sort()).toEqual(['A', 'B', 'C', 'D']);

    const byId = new Map(r.findings.map((f) => [f.ref.findingId, f]));
    expect(byId.get('A')!.ref.elementId).toBe('el-a');
    expect(byId.get('D')!.ref.elementId).toBe('el-d');
    expect(byId.get('B')!.ref.bbox).toEqual([0, 0, 50, 50]);
    expect(byId.get('C')!.ref.bbox).toEqual([60, 0, 50, 50]);

    // Rollup is the strongest across all (all confirmed, none critical) → SANITIZE.
    expect(r.overall.action).toBe('SANITIZE');
    expect(r.overall.signals).toEqual(
      expect.arrayContaining(['contact', 'identity', 'payment']),
    );
  });

  it('findings order is deterministic regardless of input order', () => {
    const a = decidePolicyReport({
      entities: [
        entity({ id: '1', category: 'EMAIL', confidence: 1 }),
        entity({ id: '2', category: 'PASSWORD', confidence: 1 }),
      ],
    });
    const b = decidePolicyReport({
      entities: [
        entity({ id: '2', category: 'PASSWORD', confidence: 1 }),
        entity({ id: '1', category: 'EMAIL', confidence: 1 }),
      ],
    });
    expect(a).toEqual(b);
    // Strongest finding sorts first.
    expect(a.findings[0]!.action).toBe('BLOCK');
  });
});

describe('decidePolicyReport — mixed text + visual findings', () => {
  it('keeps both a DOM entity and a visual region, rolls up to the stronger', () => {
    const r = decidePolicyReport({
      entities: [entity({ id: 'txt', category: 'EMAIL', confidence: 1 })],
      visual: completedVisual([textLikeObservation(0.9)]),
    });
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.ref.source).sort()).toEqual(['DOM', 'VISION']);

    const visualFinding = r.findings.find((f) => f.signal === 'visual_uncertain')!;
    expect(visualFinding.action).toBe('WARN');
    expect(visualFinding.reasonCode).toBe('VISUAL_UNCERTAINTY');
    expect(visualFinding.ref.findingId).toBe('r1'); // region id from the observation
    expect(visualFinding.ref.bbox).toEqual([0, 0, 100, 40]);

    // SANITIZE (email) outranks WARN (visual uncertainty).
    expect(r.overall.action).toBe('SANITIZE');
  });

  it('emits one finding per confident text-like region', () => {
    const r = decidePolicyReport({
      entities: [],
      visual: completedVisual([
        { ...textLikeObservation(0.8), region: { id: 'rA', x: 0, y: 0, width: 10, height: 10 } },
        { ...textLikeObservation(0.9), region: { id: 'rB', x: 20, y: 0, width: 10, height: 10 } },
      ]),
    });
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.ref.findingId).sort()).toEqual(['rA', 'rB']);
    expect(r.overall.action).toBe('WARN');
  });
});

describe('decidePolicyReport — overlapping, duplicate, and conflicting findings', () => {
  it('preserves overlapping-but-distinct regions (merging is a later concern)', () => {
    const r = decidePolicyReport({
      entities: [
        entity({ id: 'o1', category: 'ID', source: 'VISION', bbox: [0, 0, 100, 100], confidence: 1 }),
        entity({ id: 'o2', category: 'ID', source: 'VISION', bbox: [50, 50, 100, 100], confidence: 1 }),
      ],
    });
    expect(r.findings).toHaveLength(2);
  });

  it('collapses exact duplicate findings (same id) to one', () => {
    const dup = entity({ id: 'same', category: 'EMAIL', confidence: 1 });
    const r = decidePolicyReport({ entities: [dup, { ...dup }] });
    expect(r.findings).toHaveLength(1);
    expect(r.overall.action).toBe('SANITIZE');
  });

  it('resolves a conflict on the same id to the stronger action (fail closed)', () => {
    const r = decidePolicyReport({
      entities: [
        entity({ id: 'x', category: 'EMAIL', confidence: 1 }), // SANITIZE
        entity({ id: 'x', category: 'PASSWORD', confidence: 1 }), // BLOCK
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.action).toBe('BLOCK');
    expect(r.overall.action).toBe('BLOCK');
  });
});

describe('decidePolicyReport — malformed region fails closed, is not dropped', () => {
  it('surfaces a malformed entity as a WARN finding rather than discarding it', () => {
    const r = decidePolicyReport({
      entities: [{ region: 'not-a-real-entity' } as unknown as SensitiveEntity],
    });
    expect(r.overall.action).toBe('WARN');
    expect(r.overall.reasonCode).toBe('MALFORMED_SIGNAL');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.reasonCode).toBe('MALFORMED_SIGNAL');
  });
});

describe('decidePolicyReport — a finding exposes only the allowed fields', () => {
  it('has exactly {ref, action, severity, reasonCode, signal, confidence} and no raw value', () => {
    const secret = 'inline.secret+kk@example.test';
    const r = decidePolicyReport({
      entities: [
        entity({
          id: 'k',
          category: 'EMAIL',
          text: secret,
          elementId: 'el',
          bbox: [1, 2, 3, 4],
          confidence: 1,
        }),
      ],
    });
    const f = r.findings[0]!;
    expect(Object.keys(f).sort()).toEqual([
      'action',
      'confidence',
      'reasonCode',
      'ref',
      'severity',
      'signal',
    ]);
    expect(Object.keys(f.ref).sort()).toEqual(['bbox', 'elementId', 'findingId', 'source']);
    expect(f.ref).not.toHaveProperty('text');
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
