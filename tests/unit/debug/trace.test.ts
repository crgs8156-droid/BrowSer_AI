import { describe, expect, it, beforeEach } from 'vitest';
import { emitTrace, getTrace, setTraceEnabled, startTrace } from '../../../extension/src/debug/trace';

const CANARY = 'CANARY_TRACE_001@example.test';

describe('debug trace', () => {
  beforeEach(() => { setTraceEnabled(true); startTrace(); });
  it('emits in correct order', () => {
    emitTrace({ stage: 'DOM scan started' });
    emitTrace({ stage: 'PII scan', detail: '3 items' });
    emitTrace({ stage: 'Firewall check: PASS' });
    const t = getTrace();
    expect(t[0]!.stage).toBe('DOM scan started');
    expect(t[2]!.stage).toBe('Firewall check: PASS');
  });
  it('no raw values in any trace (canary)', () => {
    emitTrace({ stage: 'Action: TYPE #email', detail: 'USER_EMAIL_1' });
    const txt = getTrace().map((e) => e.formatted).join(' ');
    expect(txt).not.toContain(CANARY);
    expect(txt).toContain('USER_EMAIL_1');
  });
  it('selector truncated to 30 chars', () => {
    const long = '#a'.repeat(40);
    emitTrace({ stage: 'Action: TYPE', detail: long });
    const e = getTrace()[0];
    const detail = (e as { detail?: string }).detail!; expect(detail.length).toBeLessThanOrEqual(30);
  });
  it('max 50 events enforced', () => {
    for (let i=0;i<60;i++) emitTrace({ stage: `s${i}` });
    expect(getTrace().length).toBe(50);
    expect(getTrace()[0]!.stage).toBe('s10');
  });
  it('clears on disable', () => {
    emitTrace({ stage: 'x' });
    setTraceEnabled(false);
    expect(getTrace().length).toBe(0);
    setTraceEnabled(true);
    startTrace();
    expect(getTrace().length).toBe(0);
  });
});
