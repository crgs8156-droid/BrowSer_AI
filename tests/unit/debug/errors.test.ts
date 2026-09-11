import { describe, expect, it } from 'vitest';
import { classifyError } from '../../../extension/src/debug/errors';

describe('error classifier', () => {
  it('fetch error → network, recoverable', () => {
    const e = classifyError('fetch failed ECONNREFUSED');
    expect(e.category).toBe('network');
    expect(e.recoverable).toBe(true);
    expect(e.message).toBe('Backend unreachable');
  });
  it('HTTP 502 llm_timeout → llm_timeout, recoverable', () => {
    const e = classifyError('llm_timeout', 502);
    expect(e.category).toBe('llm_timeout');
    expect(e.recoverable).toBe(true);
  });
  it('HTTP 422 → firewall_block, not recoverable', () => {
    const e = classifyError('PII_DETECTED', 422);
    expect(e.category).toBe('firewall_block');
    expect(e.recoverable).toBe(false);
  });
  it('JSON parse error → llm_parse, recoverable', () => {
    const e = classifyError('JSON.parse failure on LLM response');
    expect(e.category).toBe('llm_parse');
    expect(e.recoverable).toBe(true);
  });
  it('Permission error → permission, not recoverable', () => {
    const e = classifyError('chrome.tabs permission denied');
    expect(e.category).toBe('permission');
    expect(e.recoverable).toBe(false);
  });
  it('structural firewall verdicts never claim PII', () => {
    const malformed = classifyError('FIREWALL_MALFORMED');
    expect(malformed.category).toBe('firewall_block');
    expect(malformed.debugHint).not.toMatch(/PII/i);
    const pii = classifyError('FIREWALL_PII_DETECTED');
    expect(pii.category).toBe('firewall_block');
    expect(pii.debugHint).toMatch(/PII/i);
  });
  it('All categories have non-empty message', () => {
    const cats = ['network','llm_timeout','llm_parse','firewall_block','dom_access','model_load','permission','captcha','max_steps','vault_empty','unknown'];
    for (const c of cats) {
      const e = classifyError(c);
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.debugHint.length).toBeGreaterThan(0);
    }
  });
});
