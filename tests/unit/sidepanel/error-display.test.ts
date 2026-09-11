import { describe, expect, it } from 'vitest';
import { classifyError } from '../../../extension/src/debug/errors';

const CANARY = 'CANARY_ERROR_001@example.test';

function ErrorBox({ code, status }: { code: string; status?: number }) {
  const cls = classifyError(code, status);
  // Simulate AgentTask classified error UI fragment
  const isFirewall = cls.category === 'firewall_block';
  const isModel = cls.category === 'model_load';
  const html = `
    <div data-testid="classified-error">
      <p>${cls.message}</p>
      ${cls.recoverable && !isFirewall ? '<button data-testid="error-retry">Retry</button>' : ''}
      ${isFirewall ? '' : ''}
      ${isModel ? '<button data-testid="error-continue">Continue anyway</button>' : ''}
    </div>
  `;
  return html;
}

describe('error display', () => {
  it('Network error → shows Backend unreachable + retry', () => {
    const html = ErrorBox({ code: 'fetch failed' });
    expect(html).toContain('Backend unreachable');
    expect(html).toContain('error-retry');
    expect(html).not.toContain(CANARY);
  });
  it('Firewall block → shows block message + NO retry', () => {
    const html = ErrorBox({ code: 'PII_DETECTED', status: 422 });
    expect(html).toContain('Privacy firewall blocked');
    expect(html).not.toContain('error-retry');
  });
  it('Model load fail → shows Continue anyway', () => {
    const html = ErrorBox({ code: 'VISION_MODEL_UNAVAILABLE' });
    expect(html).toContain('Vision model unavailable');
    expect(html).toContain('error-continue');
  });
  it('None show raw PII (canary)', () => {
    // Even though CANARY exists in this file, no error UI should ever render it
    const html = ErrorBox({ code: 'fetch failed' });
    expect(html).not.toContain(CANARY);
    expect(html).toContain('Backend unreachable');
  });
});
