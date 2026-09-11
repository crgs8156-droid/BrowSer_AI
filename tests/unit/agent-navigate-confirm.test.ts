import { describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from '../../extension/src/agent/loop';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import { getNavigationAllowlist } from '../../extension/src/agent/session-policy';
import { DEFAULT_ACTION_POLICY } from '../../extension/src/actions/validate';
import type { ScanPageResponse } from '../../extension/src/types/messages';

function scan(): Promise<ScanPageResponse> {
  return Promise.resolve({
    pageText: 'hello',
    snapshot: { url: 'https://site.test/', viewport: { width: 1, height: 1 }, domTextLength: 0, candidates: [] },
    structure: [],
  });
}

describe('navigate confirmation gate (Part C)', () => {
  it('blocks off-allowlist NAVIGATE without approval (fail closed)', async () => {
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'go somewhere',
      sessionId: 'nav-1',
      vault,
      gateway: { plan: async () => [{ action: 'NAVIGATE', url: 'https://other.test/page' }] },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      navigationAllowlist: ['https://site.test'],
      scan,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('NAVIGATE_NEEDS_APPROVAL');
    expect(result.actionsExecuted).toBe(0);
  });

  it('executes after user approval and allows same-origin next step', async () => {
    const vault = createLocalVault();
    const sendToPage = vi.fn(async () => ({ ok: true as const, code: 'OK' }));
    const confirm = vi.fn(async (_url: string) => true);
    const result = await runAgentLoop({
      task: 'go somewhere',
      sessionId: 'nav-2',
      vault,
      gateway: { plan: async () => [{ action: 'NAVIGATE', url: 'https://other.test/page' }] },
      bridge: createActionBridge({ vault, sendToPage, policy: () => ({ ...DEFAULT_ACTION_POLICY, navigationAllowlist: [...getNavigationAllowlist()] }) }),
      firewall: createPrivacyFirewall(),
      navigationAllowlist: ['https://site.test'],
      onNavigateConfirm: confirm,
      maxSteps: 1,
      scan,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(sendToPage).toHaveBeenCalledOnce();
    expect(result.actionsExecuted).toBe(1);
  });

  it('denies on explicit No', async () => {
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'go somewhere',
      sessionId: 'nav-3',
      vault,
      gateway: { plan: async () => [{ action: 'NAVIGATE', url: 'https://other.test/page' }] },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      navigationAllowlist: ['https://site.test'],
      onNavigateConfirm: async () => false,
      scan,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('NAVIGATE_NEEDS_APPROVAL');
  });
});
