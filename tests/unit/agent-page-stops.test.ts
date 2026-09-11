import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../../extension/src/agent/loop';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import type { ScanPageResponse } from '../../extension/src/types/messages';

function scanWith(text: string, url = 'https://site.test/'): () => Promise<ScanPageResponse> {
  return () =>
    Promise.resolve({
      pageText: text,
      snapshot: { url, viewport: { width: 1, height: 1 }, domTextLength: 0, candidates: [] },
      structure: [],
    });
}

describe('loop safety stops (Phase 1)', () => {
  it('pauses with paused_captcha on CAPTCHA pages and never executes', async () => {
    const vault = createLocalVault();
    let planned = 0;
    const result = await runAgentLoop({
      task: 'fill the form',
      sessionId: 'captcha-1',
      vault,
      gateway: {
        plan: async () => {
          planned++;
          return [{ action: 'CLICK', target: '#x' }];
        },
      },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scanWith("I'm not a robot — complete the captcha"),
    });
    expect(result.status).toBe('paused_captcha');
    expect(result.reason).toBe('CAPTCHA_DETECTED');
    expect(result.actionsExecuted).toBe(0);
    expect(planned).toBe(0);
  });

  it('stops on error pages with an origin-only reason', async () => {
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form',
      sessionId: 'err-1',
      vault,
      gateway: { plan: async () => [{ action: 'CLICK', target: '#x' }] },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scanWith('404 not found — page does not exist'),
    });
    expect(result.status).toBe('stopped');
    expect(result.reason).toContain('Error page detected on step 0');
    expect(result.reason).toContain('https://site.test');
    expect(result.reason).not.toContain('404 not found');
    expect(result.actionsExecuted).toBe(0);
  });
});
