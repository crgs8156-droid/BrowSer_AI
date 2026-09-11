import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ScanDetails, maskForCategory } from '../../../extension/src/sidepanel/ScanDetails';
import type { ScanSummary } from '../../../extension/src/scan';

const CANARY_EMAIL = 'CANARY_SCAN_TEST@example.test';

function summaryWith(total: number): ScanSummary {
  return {
    status: 'complete',
    total,
    textCount: total,
    imageCount: 0,
    findings: [],
    blocked: false,
    restricted: false,
    enforced: true,
  };
}

describe('scan details panel', () => {
  it('3 PII items → table shows 3 rows', () => {
    const html = renderToString(createElement(ScanDetails, {
        summary: summaryWith(3),
        findings: [
          { alias: 'USER_EMAIL_1', category: 'EMAIL', masked: maskForCategory(CANARY_EMAIL, 'EMAIL'), label: 'Email', source: 'Input field', confidence: 'High' },
          { alias: 'USER_PHONE_1', category: 'PHONE', masked: maskForCategory('9876543210', 'PHONE'), label: 'Phone', source: 'Text label', confidence: 'High' },
          { alias: 'USER_AADHAAR_1', category: 'AADHAAR', masked: maskForCategory('234567890123', 'AADHAAR'), label: 'Aadhaar', source: 'Form label', confidence: 'High' },
        ],
        fields: { inputs: 3, textareas: 0, labels: 3, total: 6, sensitive: 3, safe: 3 },
        policy: { decision: 'Sanitize', signals: ['PII_DETECTED'], mode: 'Strict' },
      }))
    // Should have 3 rows (we check for alias presence)
    expect((html.match(/USER_/g) || []).length).toBe(3);
  });
  it('Email row shows masked value (not full email)', () => {
    const masked = maskForCategory(CANARY_EMAIL, 'EMAIL');
    expect(masked).not.toContain(CANARY_EMAIL);
    expect(masked).toContain('\u2022');
    expect(masked).toContain('@');
  });
  it('Password always shows bullets regardless of value', () => {
    expect(maskForCategory('hunter2secret', 'PASSWORD')).toBe('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
    expect(maskForCategory('abc', 'PASSWORD')).toBe('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
  });
  it('Full email never appears in rendered HTML (canary)', () => {
    const html = renderToString(createElement(ScanDetails, {
        summary: summaryWith(1),
        findings: [{ alias: 'USER_EMAIL_1', category: 'EMAIL', masked: maskForCategory(CANARY_EMAIL, 'EMAIL'), label: 'Email', source: 'Input field', confidence: 'High' }],
        fields: { inputs: 1, textareas: 0, labels: 1, total: 2, sensitive: 1, safe: 1 },
        policy: { decision: 'Sanitize', signals: [], mode: 'Strict' },
      })
    );
    expect(html).not.toContain(CANARY_EMAIL);
    expect(html).not.toContain('CANARY_SCAN_TEST');
  });
  it('Nothing detected state renders correctly', () => {
    const html = renderToString(createElement(ScanDetails, {
        summary: summaryWith(0),
        findings: [],
        fields: { inputs: 2, textareas: 0, labels: 2, total: 4, sensitive: 0, safe: 4 },
        policy: { decision: 'No PII', signals: [], mode: 'Strict' },
      })
    );
    expect(html).toContain('No sensitive fields detected');
  });
  it('Uses bullet characters not asterisks', () => {
    const m = maskForCategory('test@example.com', 'EMAIL');
    expect(m).toContain('\u2022');
    expect(m).not.toContain('*');
  });
});
