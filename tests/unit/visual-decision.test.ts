// M3 — DOM-first decision logic.
// The property under test: visual perception is OFF by default and only switches on
// for content the DOM genuinely cannot describe.

import { describe, expect, it } from 'vitest';
import {
  MIN_CANDIDATE_AREA,
  PAINTED_AREA_RATIO,
  SPARSE_DOM_TEXT_CHARS,
  decideVisualPerception,
} from '../../extension/src/perception/visual/decision';
import type { DomVisualCandidate, DomVisualSnapshot } from '../../extension/src/types/contracts';

function candidate(overrides: Partial<DomVisualCandidate> = {}): DomVisualCandidate {
  return {
    kind: 'image',
    rect: { x: 0, y: 0, width: 200, height: 200 },
    hasAccessibleText: false,
    domTextLength: 0,
    ...overrides,
  };
}

function snapshot(overrides: Partial<DomVisualSnapshot> = {}): DomVisualSnapshot {
  return {
    url: 'https://example.test/page',
    viewport: { width: 1280, height: 800 },
    domTextLength: 5000,
    candidates: [],
    ...overrides,
  };
}

describe('decideVisualPerception — skips work', () => {
  it('does not run on a text page with no visual candidates', () => {
    const decision = decideVisualPerception(snapshot());
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe('no_visual_candidates');
  });

  it('does not run when the DOM already describes the image', () => {
    const decision = decideVisualPerception(
      snapshot({ candidates: [candidate({ hasAccessibleText: true })] }),
    );
    expect(decision.required).toBe(false);
    expect(decision.reason).toBe('dom_sufficient');
  });

  it('does not run when the node already exposes inner text', () => {
    const decision = decideVisualPerception(
      snapshot({ candidates: [candidate({ kind: 'svg', domTextLength: 42 })] }),
    );
    expect(decision.required).toBe(false);
  });

  it('ignores decorative icons and tracking pixels', () => {
    const decision = decideVisualPerception(
      snapshot({
        candidates: [
          candidate({ rect: { x: 0, y: 0, width: 1, height: 1 } }),
          candidate({ rect: { x: 0, y: 0, width: 24, height: 24 } }),
        ],
      }),
    );
    expect(decision.required).toBe(false);
  });

  it('ignores wide-but-thin strips that clear the area bar', () => {
    // area passes, but a 2px-tall element cannot hold readable text.
    const width = MIN_CANDIDATE_AREA;
    const decision = decideVisualPerception(
      snapshot({ candidates: [candidate({ rect: { x: 0, y: 0, width, height: 2 } })] }),
    );
    expect(decision.required).toBe(false);
  });

  it('treats a malformed snapshot as "no work", never as an attempt', () => {
    const decision = decideVisualPerception({} as unknown as DomVisualSnapshot);
    expect(decision.required).toBe(false);
    expect(decision.candidates).toEqual([]);
  });
});

describe('decideVisualPerception — runs work', () => {
  it('runs for a large image the DOM cannot describe', () => {
    const decision = decideVisualPerception(snapshot({ candidates: [candidate()] }));
    expect(decision.required).toBe(true);
    expect(decision.reason).toBe('visual_only_content_present');
    expect(decision.candidates).toHaveLength(1);
  });

  it('runs for a canvas-rendered app with almost no DOM text', () => {
    // Every candidate is DOM-described, so rule 1 cannot fire; the painted-area
    // fallback must catch it.
    const decision = decideVisualPerception(
      snapshot({
        domTextLength: SPARSE_DOM_TEXT_CHARS - 1,
        candidates: [
          candidate({ kind: 'canvas', hasAccessibleText: true, rect: { x: 0, y: 0, width: 1000, height: 600 } }),
        ],
      }),
    );
    expect(decision.required).toBe(true);
    expect(decision.reason).toBe('dom_text_insufficient_for_painted_area');
  });

  it('does not use the painted-area fallback when DOM text is plentiful', () => {
    const decision = decideVisualPerception(
      snapshot({
        domTextLength: SPARSE_DOM_TEXT_CHARS + 1,
        candidates: [
          candidate({ kind: 'canvas', hasAccessibleText: true, rect: { x: 0, y: 0, width: 1000, height: 600 } }),
        ],
      }),
    );
    expect(decision.required).toBe(false);
  });

  it('requires the painted area to cover a real share of the viewport', () => {
    const viewport = { width: 1000, height: 1000 };
    const edge = Math.floor(Math.sqrt(PAINTED_AREA_RATIO * 1000 * 1000) / 2);
    const decision = decideVisualPerception(
      snapshot({
        viewport,
        domTextLength: 0,
        candidates: [
          candidate({ hasAccessibleText: true, rect: { x: 0, y: 0, width: edge, height: edge } }),
        ],
      }),
    );
    expect(decision.required).toBe(false);
  });
});

describe('decideVisualPerception — decisions are content-driven', () => {
  it('reaches the same verdict regardless of which site the page is on', () => {
    const hosts = [
      'https://example.test/a',
      'https://mail.example.test/inbox',
      'https://bank.example.test/accounts',
      'https://localhost:3000/app',
    ];
    const verdicts = hosts.map(
      (url) => decideVisualPerception(snapshot({ url, candidates: [candidate()] })).reason,
    );
    expect(new Set(verdicts).size).toBe(1);
  });
});
