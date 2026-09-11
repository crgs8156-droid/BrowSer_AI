import { describe, expect, it } from 'vitest';
import { formatAgentStep, formatTerminalLine } from '../../extension/src/sidepanel/agent-step-log';

describe('agent step log formatting (Part B, privacy-safe)', () => {
  it('formats CLICK with target and outcome, no values', () => {
    const line = formatAgentStep({ index: 0, action: { action: 'CLICK', target: '#loginBtn' }, outcome: 'executed', ok: true });
    expect(line).toContain('Clicked #loginBtn');
    expect(line).toContain('executed');
  });

  it('formats TYPE without rendering the alias value', () => {
    const line = formatAgentStep({ index: 1, action: { action: 'TYPE', target: '#email', value: 'USER_EMAIL_1' }, outcome: 'executed', ok: true });
    expect(line).toContain('#email');
    expect(line).not.toContain('USER_EMAIL_1');
  });

  it('renders NAVIGATE as origin-only (strips query/path)', () => {
    const line = formatAgentStep({ index: 2, action: { action: 'NAVIGATE', url: 'https://site.test/next?token=abc' }, outcome: 'executed', ok: true });
    expect(line).toContain('https://site.test');
    expect(line).not.toContain('token=abc');
  });

  it('maps null action to task-complete with zero-leak claim', () => {
    const line = formatAgentStep({ index: 3, action: null, outcome: 'no_action', ok: true });
    expect(line).toContain('0 bytes leaked');
  });

  it('formats terminal lines without content', () => {
    expect(formatTerminalLine('completed')).toContain('0 bytes leaked');
    expect(formatTerminalLine('max_steps', 'MAX_STEPS_REACHED')).toContain('MAX_STEPS_REACHED');
  });
});
