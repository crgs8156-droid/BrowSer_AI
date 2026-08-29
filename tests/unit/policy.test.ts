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
