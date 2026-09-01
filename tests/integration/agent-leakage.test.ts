// M6 — leakage/security tests for the agent egress path (CONTRIBUTING.md §13/§14).
//
// The agent loop and the deterministic planner are PURE with respect to network: the
// only module allowed to fetch is `agent/remote.ts` (injectable transport). This suite
// asserts, with synthetic canaries:
//   1. the loop never performs ANY network I/O (fetch/XHR/WebSocket/sendBeacon are
//      stubbed to throw; a deterministic-gateway run must complete without touching them);
//   2. no console.* statement exists anywhere in the new egress-adjacent modules
//      (firewall, validate, planner, loop) — raw values cannot leak through logs;
//   3. the remote gateway transmits the request ONLY after a firewall allow verdict,
//      and the transmitted body is exactly the firewall-inspected request;
//   4. a canary planted in page text reaches neither the outbound request nor the step
//      records — only the LOCAL vault.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentLoop } from '../../extension/src/agent/loop';
import { createDeterministicPlanner } from '../../extension/src/agent/planner';
import { createRemoteHttpAgentGateway } from '../../extension/src/agent/remote';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import type { RemoteAgentRequest } from '../../extension/src/types/contracts';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';
const CANARY_PHONE = '555-123-4567';

const MODULE_ROOT = join(process.cwd(), 'extension', 'src');

function sourceFiles(relativeDir: string): string[] {
  const dir = join(MODULE_ROOT, relativeDir);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

describe('agent egress modules contain no logging and no direct network/storage', () => {
  it('firewall, validate, planner and loop sources are free of console/network/storage', () => {
    const files = [
      ...sourceFiles(join('firewall')),
      ...sourceFiles(join('actions')).filter((f) => !f.endsWith('index.ts')),
      join(MODULE_ROOT, 'agent', 'planner.ts'),
      join(MODULE_ROOT, 'agent', 'loop.ts'),
    ];
    const forbidden = /console\.|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|indexedDB|chrome\.storage/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} must not log or touch network/storage`).not.toMatch(forbidden);
    }
  });
});

describe('agent loop network isolation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('NETWORK_IO_IN_LOOP');
      }),
    );
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        open() {
          throw new Error('NETWORK_IO_IN_LOOP');
        }
        send() {
          throw new Error('NETWORK_IO_IN_LOOP');
        }
      },
    );
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('NETWORK_IO_IN_LOOP');
        }
      },
    );
    vi.stubGlobal(
      'navigator',
      Object.defineProperty({}, 'sendBeacon', {
        value: () => {
          throw new Error('NETWORK_IO_IN_LOOP');
        },
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('completes a full fill-and-submit run without any network I/O and without canary leakage', async () => {
    const state = { email: '', phone: '', submitted: false };
    const scan = async (): Promise<import('../../extension/src/types/messages').ScanPageResponse> => {
      void state;
      return {
        pageText: [
          'Demo form',
          `Contact: ${CANARY_EMAIL}`,
          `Phone: ${CANARY_PHONE}`,
          state.email,
          state.phone,
        ]
          .filter((p) => p.length > 0)
          .join('\n'),
        snapshot: null,
        structure: [
          { tag: 'input', selector: '#email', inputType: 'email', label: 'Email', value: state.email || undefined, disabled: false },
          { tag: 'input', selector: '#phone', inputType: 'tel', label: 'Phone', value: state.phone || undefined, disabled: false },
          { tag: 'button', selector: '#submit', label: 'Submit', disabled: state.submitted },
        ],
      };
    };
    const executor = async (action: import('../../extension/src/types/contracts').AgentAction) => {
      if (action.action === 'TYPE' && action.target === '#email') state.email = action.value;
      else if (action.action === 'TYPE' && action.target === '#phone') state.phone = action.value;
      else if (action.action === 'CLICK' && action.target === '#submit') state.submitted = true;
      else return { ok: false, code: 'NOT_FOUND' };
      return { ok: true, code: 'OK' };
    };

    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form with my details and submit',
      sessionId: 'leakage-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault, sendToPage: executor }),
      firewall: createPrivacyFirewall(),
      scan,
    });

    expect(result.status).toBe('completed');
    expect(state.email).toBe(CANARY_EMAIL);
    expect(state.phone).toBe(CANARY_PHONE);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    const recordJson = JSON.stringify(result.steps);
    expect(recordJson).not.toContain(CANARY_EMAIL);
    expect(recordJson).not.toContain(CANARY_PHONE);
    for (const call of vi.mocked(console.log).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CANARY_EMAIL);
    }
  });
});

describe('remote gateway firewall gate', () => {
  it('refuses to transmit when the firewall denies, and sends the inspected payload verbatim when allowed', async () => {
    const firewall = createPrivacyFirewall();
    const sentBodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(typeof init?.body === 'string' ? init.body : '');
      return new Response(JSON.stringify({ actions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const gateway = createRemoteHttpAgentGateway({
      endpoint: 'http://localhost:8000/v1/plan',
      firewall,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const clean: RemoteAgentRequest = {
      taskObjective: 'fill the form',
      sanitizedPageStructure: [
        { tag: 'input', selector: '#email', inputType: 'email', label: 'Email', filled: false, disabled: false },
      ],
      sanitizedVisibleText: 'Email field',
      aliases: [{ alias: 'USER_EMAIL_1', category: 'EMAIL' }],
      availableActions: ['CLICK', 'TYPE'],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
    };
    await expect(gateway.plan(clean)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentBodies[0]).toBe(JSON.stringify(clean));

    const leaking: RemoteAgentRequest = {
      ...clean,
      sanitizedVisibleText: `reach me at ${CANARY_EMAIL}`,
    };
    await expect(gateway.plan(leaking)).rejects.toThrow(/firewall blocked/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sentBodies)).not.toContain(CANARY_EMAIL);
  });

  it('rejects malformed planner responses instead of executing them', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ actions: [{ action: 'EVAL', code: 'alert(1)' }] }), { status: 200 }),
    );
    const gateway = createRemoteHttpAgentGateway({
      endpoint: 'http://localhost:8000/v1/plan',
      firewall: createPrivacyFirewall(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const request: RemoteAgentRequest = {
      taskObjective: 'x',
      sanitizedPageStructure: [],
      sanitizedVisibleText: '',
      aliases: [],
      availableActions: ['CLICK'],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
    };
    await expect(gateway.plan(request)).rejects.toThrow(/invalid action/);
  });
});
