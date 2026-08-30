// Unit tests for the pure display-summary builder (M5 EnforcementResult → ScanSummary).
//
// PRIVACY: the summary the side panel renders must carry ONLY aliases, geometry,
// sections, severities and dispositions — never a raw value, page text or pixels.
// These tests also pin the multi-region behaviour: every text alias and every visual
// mask directive surfaces as its own row; nothing is collapsed or dropped.

import { describe, expect, it } from 'vitest';
import { buildScanSummary } from '../../extension/src/scan/summary';
import type {
  AliasBinding,
  EnforcementResult,
  FindingEnforcement,
  VisualMaskDirective,
} from '../../extension/src/types/contracts';

function result(overrides: Partial<EnforcementResult> = {}): EnforcementResult {
  return {
    sanitizedText: '',
    aliases: [],
    visualMasks: [],
    findings: [],
    blocked: false,
    restricted: false,
    enforced: true,
    local: true,
    ...overrides,
  };
}

function aliased(alias: string, findingId: string): FindingEnforcement {
  return {
    ref: { source: 'DOM', findingId },
    action: 'SANITIZE',
    severity: 'high',
    disposition: 'aliased',
    alias,
  };
}

function mask(bbox: [number, number, number, number], ids: string[]): VisualMaskDirective {
  return { bbox, findingIds: ids, source: 'VISION' };
}

describe('buildScanSummary — text findings', () => {
  it('surfaces every aliased finding as its own row (multiple, not just the first)', () => {
    const aliases: AliasBinding[] = [
      { alias: 'USER_EMAIL_1', category: 'EMAIL' },
      { alias: 'USER_EMAIL_2', category: 'EMAIL' },
      { alias: 'USER_PHONE_1', category: 'PHONE' },
    ];
    const summary = buildScanSummary(
      result({
        aliases,
        findings: [
          aliased('USER_EMAIL_1', 'email-0'),
          aliased('USER_EMAIL_2', 'email-1'),
          aliased('USER_PHONE_1', 'phone-0'),
        ],
      }),
    );

    expect(summary.textCount).toBe(3);
    expect(summary.total).toBe(3);
    expect(summary.findings.map((f) => f.displayId)).toEqual([
      'USER_EMAIL_1',
      'USER_EMAIL_2',
      'USER_PHONE_1',
    ]);
    expect(summary.findings.every((f) => f.kind === 'text')).toBe(true);
  });

  it('labels categories from the alias directory, falling back to CUSTOM', () => {
    const summary = buildScanSummary(
      result({
        aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
        // second alias intentionally absent from the directory → CUSTOM fallback
        findings: [aliased('USER_EMAIL_1', 'email-0'), aliased('USER_MYSTERY_1', 'x-0')],
      }),
    );

    expect(summary.findings[0]).toMatchObject({ category: 'EMAIL', label: 'Email' });
    expect(summary.findings[1]).toMatchObject({ category: 'CUSTOM', label: 'Sensitive value' });
  });
});

describe('buildScanSummary — image/visual findings', () => {
  it('surfaces every mask directive as an independent IMAGE_REGION_n (no merge/drop)', () => {
    const summary = buildScanSummary(
      result({
        visualMasks: [
          mask([0, 0, 300, 200], ['r-a']),
          mask([400, 0, 300, 200], ['r-b']),
          mask([0, 900, 300, 200], ['r-c']),
          mask([400, 1700, 300, 200], ['r-d']),
        ],
      }),
      800, // viewport height
    );

    expect(summary.imageCount).toBe(4);
    expect(summary.findings.map((f) => f.displayId)).toEqual([
      'IMAGE_REGION_1',
      'IMAGE_REGION_2',
      'IMAGE_REGION_3',
      'IMAGE_REGION_4',
    ]);
    expect(summary.findings.every((f) => f.kind === 'image')).toBe(true);
    // No fabricated category for images (no OCR bundled).
    expect(summary.findings.every((f) => f.category === undefined)).toBe(true);
  });

  it('computes 1-based page sections from bbox.y relative to viewport height', () => {
    const summary = buildScanSummary(
      result({
        visualMasks: [
          mask([0, 0, 100, 100], ['a']), // section 1
          mask([0, 850, 100, 100], ['b']), // section 2
          mask([0, 2500, 100, 100], ['c']), // section 4
        ],
      }),
      800,
    );
    expect(summary.findings.map((f) => f.section)).toEqual([1, 2, 4]);
  });

  it('defaults every section to 1 when the viewport height is unknown', () => {
    const summary = buildScanSummary(
      result({ visualMasks: [mask([0, 5000, 100, 100], ['a'])] }),
      undefined,
    );
    expect(summary.findings[0]?.section).toBe(1);
  });

  it('carries geometry (rounded) but never raw content for image rows', () => {
    const summary = buildScanSummary(
      result({ visualMasks: [mask([12.7, 30.2, 300.6, 200.4], ['a'])] }),
      800,
    );
    expect(summary.findings[0]?.geometry).toEqual({ width: 301, height: 200 });
  });
});

describe('buildScanSummary — mixed + unresolved', () => {
  it('orders text before image before unresolved and counts each kind', () => {
    const summary = buildScanSummary(
      result({
        aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
        findings: [
          aliased('USER_EMAIL_1', 'email-0'),
          {
            ref: { source: 'DOM', findingId: 'bad-0' },
            action: 'WARN',
            severity: 'medium',
            disposition: 'flagged',
          },
        ],
        visualMasks: [mask([0, 0, 300, 200], ['r-a'])],
      }),
      800,
    );

    expect(summary.textCount).toBe(2); // 1 aliased + 1 unresolved (findingId-only → text)
    expect(summary.imageCount).toBe(1);
    expect(summary.total).toBe(3);
    expect(summary.findings.map((f) => f.displayId)).toEqual([
      'USER_EMAIL_1',
      'IMAGE_REGION_1',
      'UNRESOLVED_1',
    ]);
  });

  it('never drops flagged/inaccessible findings — the user is told honestly', () => {
    const summary = buildScanSummary(
      result({
        findings: [
          {
            ref: { source: 'OCR', bbox: [0, 1600, 100, 100] },
            action: 'WARN',
            severity: 'low',
            disposition: 'inaccessible',
          },
          {
            ref: { source: 'DOM', findingId: 'bad-0' },
            action: 'WARN',
            severity: 'medium',
            disposition: 'flagged',
          },
        ],
      }),
      800,
    );

    const unresolved = summary.findings.filter((f) => f.displayId.startsWith('UNRESOLVED_'));
    expect(unresolved).toHaveLength(2);
    // A bbox-bearing unresolved finding is treated as an image row with a section.
    expect(unresolved[0]).toMatchObject({ kind: 'image', section: 3 });
    // A findingId-only unresolved finding is a text row with no section.
    expect(unresolved[1]).toMatchObject({ kind: 'text', section: undefined });
  });
});

describe('buildScanSummary — deduplication (regression: duplicate rows in the UI)', () => {
  it('collapses multiple aliased findings that share one alias into ONE row', () => {
    // Reproduces the reported bug: an email present in visible text AND a form field
    // value is detected twice → two entities → two aliased findings, both USER_EMAIL_1.
    // A phone seen twice → USER_PHONE_1 twice, plus two genuinely distinct phones.
    const summary = buildScanSummary(
      result({
        aliases: [
          { alias: 'USER_EMAIL_1', category: 'EMAIL' },
          { alias: 'USER_PHONE_1', category: 'PHONE' },
          { alias: 'USER_PHONE_2', category: 'PHONE' },
          { alias: 'USER_PHONE_3', category: 'PHONE' },
        ],
        findings: [
          aliased('USER_EMAIL_1', 'email-0'),
          aliased('USER_EMAIL_1', 'email-120'), // same value, second occurrence
          aliased('USER_PHONE_1', 'phone-5'),
          aliased('USER_PHONE_1', 'phone-140'), // same value, second occurrence
          aliased('USER_PHONE_2', 'phone-40'),
          aliased('USER_PHONE_3', 'phone-88'),
        ],
      }),
    );

    // Six raw findings collapse to four UNIQUE display rows.
    expect(summary.total).toBe(4);
    expect(summary.textCount).toBe(4);
    expect(summary.findings.map((f) => f.displayId)).toEqual([
      'USER_EMAIL_1',
      'USER_PHONE_1',
      'USER_PHONE_2',
      'USER_PHONE_3',
    ]);
    // No displayId appears more than once.
    const ids = summary.findings.map((f) => f.displayId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the strongest severity when duplicates disagree', () => {
    const summary = buildScanSummary(
      result({
        aliases: [{ alias: 'USER_PASSWORD_1', category: 'PASSWORD' }],
        findings: [
          { ...aliased('USER_PASSWORD_1', 'secret-0'), severity: 'medium' },
          { ...aliased('USER_PASSWORD_1', 'secret-9'), severity: 'critical' },
        ],
      }),
    );
    expect(summary.total).toBe(1);
    expect(summary.findings[0]?.severity).toBe('critical');
  });

  it('does NOT merge genuinely distinct values that happen to share a category', () => {
    const summary = buildScanSummary(
      result({
        aliases: [
          { alias: 'USER_EMAIL_1', category: 'EMAIL' },
          { alias: 'USER_EMAIL_2', category: 'EMAIL' },
        ],
        findings: [aliased('USER_EMAIL_1', 'email-0'), aliased('USER_EMAIL_2', 'email-50')],
      }),
    );
    expect(summary.total).toBe(2);
  });
});

describe('buildScanSummary — source tagging (DOM vs OCR vs visual)', () => {
  it('tags text rows with their perception source', () => {
    const summary = buildScanSummary(
      result({
        aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
        findings: [aliased('USER_EMAIL_1', 'email-0')],
      }),
    );
    expect(summary.findings[0]?.source).toBe('DOM');
  });

  it('labels an OCR-sourced masked region distinctly from a plain visual region', () => {
    const summary = buildScanSummary(
      result({
        visualMasks: [
          { bbox: [0, 0, 100, 40], findingIds: ['r-ocr'], source: 'OCR' },
          { bbox: [0, 500, 100, 40], findingIds: ['r-vis'], source: 'VISION' },
        ],
      }),
      800,
    );
    const [ocrRow, visRow] = summary.findings;
    expect(ocrRow).toMatchObject({ displayId: 'OCR_REGION_1', source: 'OCR' });
    expect(ocrRow?.label).toContain('OCR');
    expect(visRow).toMatchObject({ displayId: 'IMAGE_REGION_2', source: 'VISION' });
  });
});

describe('buildScanSummary — passthrough flags', () => {  it('passes blocked/restricted/enforced through and sets status', () => {
    expect(buildScanSummary(result({ blocked: true })).blocked).toBe(true);
    expect(buildScanSummary(result({ restricted: true })).status).toBe('restricted');
    expect(buildScanSummary(result({ enforced: false })).enforced).toBe(false);
    expect(buildScanSummary(result()).status).toBe('complete');
  });
});

describe('buildScanSummary — no raw content leaks into the summary', () => {
  it('serialises to aliases/labels/geometry/sections only — no raw values or findingIds', () => {
    const RAW_EMAIL = 'canary_person_9182@example.test';
    const RAW_CARD = '4111111111111111';
    const summary = buildScanSummary(
      result({
        // Raw values live in findingId/ref only in a real result; the builder must not
        // copy them. We simulate a hostile ref carrying a raw-looking id.
        aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
        findings: [
          {
            ref: { source: 'DOM', findingId: RAW_EMAIL, elementId: RAW_CARD },
            action: 'SANITIZE',
            severity: 'high',
            disposition: 'aliased',
            alias: 'USER_EMAIL_1',
          },
        ],
        visualMasks: [mask([0, 0, 300, 200], [RAW_CARD])],
      }),
      800,
    );

    const json = JSON.stringify(summary);
    expect(json).not.toContain(RAW_EMAIL);
    expect(json).not.toContain(RAW_CARD);
    for (const finding of summary.findings) {
      expect(finding.displayId).not.toContain(RAW_EMAIL);
      expect(finding.displayId).not.toContain(RAW_CARD);
    }
  });
});
