import { describe, expect, it } from 'vitest';
import { runAgentLoop, toSanitizedNodes } from '../../extension/src/agent/loop';
import { createDeterministicPlanner } from '../../extension/src/agent/planner';
import { createActionBridge } from '../../extension/src/actions';
import { createPrivacyFirewall } from '../../extension/src/firewall';
import { createLocalVault } from '../../extension/src/vault';
import type { AgentAction, RemoteAgentRequest } from '../../extension/src/types/contracts';
import type { FieldStructure, ScanPageResponse } from '../../extension/src/types/messages';

const CANARY_EMAIL = 'CANARY_EMAIL_001@example.test';
const CANARY_PHONE = '555-123-4567';

/** Mutable fake page state; `scan` renders it the way the content script would. */
function fakePage() {
  const state = { email: '', phone: '', submitDisabled: false };
  const scan = async (): Promise<ScanPageResponse> => ({
    pageText: [
      'Demo form — enter your contact details',
      `Example format: ${CANARY_EMAIL}`,
      `Example format: ${CANARY_PHONE}`,
      state.email,
      state.phone,
    ]
      .filter((part) => part.length > 0)
      .join('\n'),
    snapshot: null,
    structure: [
      { tag: 'input', selector: '#email', inputType: 'email', label: 'Email', value: state.email || undefined, disabled: false },
      { tag: 'input', selector: '#phone', inputType: 'tel', name: 'phone', label: 'Phone', value: state.phone || undefined, disabled: false },
      { tag: 'button', selector: '#submit', label: 'Submit', disabled: state.submitDisabled },
    ] satisfies FieldStructure[],
  });

  /** The "page": a resolved TYPE writes the real value; CLICK disables the button. */
  const executor = async (action: AgentAction) => {
    if (action.action === 'TYPE' && action.target === '#email') state.email = action.value;
    else if (action.action === 'TYPE' && action.target === '#phone') state.phone = action.value;
    else if (action.action === 'CLICK' && action.target === '#submit') state.submitDisabled = true;
    else return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, code: 'OK' };
  };
  return { state, scan, executor };
}

function buildLoop(page: ReturnType<typeof fakePage>, task: string) {
  const seenRequests: RemoteAgentRequest[] = [];
  const vault = createLocalVault();
  const planner = createDeterministicPlanner();
  const gateway = {
    plan: async (request: RemoteAgentRequest) => {
      seenRequests.push(request);
      return planner.plan(request);
    },
  };
  const run = () =>
    runAgentLoop({
      task,
      sessionId: 'test-session',
      vault,
      gateway,
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });
  return { run, seenRequests, vault };
}

describe('agent loop (deterministic, in-extension)', () => {
  it('fills both fields via aliases, submits, and completes', async () => {
    const page = fakePage();
    const { run, seenRequests, vault } = buildLoop(page, 'fill the form with my details and submit');

    const result = await run();

    expect(result.status).toBe('completed');
    expect(result.actionsExecuted).toBe(3);
    // Alias resolution happened LOCALLY: the executor received the real values…
    expect(page.state.email).toBe(CANARY_EMAIL);
    expect(page.state.phone).toBe(CANARY_PHONE);
    // …while every outbound request carried aliases only — never a raw value.
    for (const request of seenRequests) {
      const json = JSON.stringify(request);
      expect(json).not.toContain(CANARY_EMAIL);
      expect(json).not.toContain(CANARY_PHONE);
    }
    // The vault (local, in memory) holds the alias→value mapping.
    expect(await vault.resolve('USER_EMAIL_1')).toBe(CANARY_EMAIL);
  });

  it('never exposes the resolved value in step records', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, 'fill the form with my details and submit');
    const result = await run();
    const json = JSON.stringify(result.steps);
    expect(json).not.toContain(CANARY_EMAIL);
    expect(json).not.toContain(CANARY_PHONE);
    expect(json).toContain('USER_EMAIL_1');
  });

  it('stops fail-closed when the page carries a critical credential', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, 'fill the form');
    // Simulate a password field on the page: credential pattern in page text ⇒ BLOCK.
    const inner = page.scan;
    page.scan = async () => ({
      ...(await inner()),
      pageText: 'password: hunter2hunter2',
    });
    const result = await run();
    expect(result.status).toBe('blocked');
    expect(result.actionsExecuted).toBe(0);
  });

  it('stops on a restricted surface and on scan failure', async () => {
    const restricted = fakePage();
    const restrictedRun = buildLoop(restricted, 'fill the form');
    restricted.scan = async () => ({ restricted: true });
    expect((await restrictedRun.run()).status).toBe('restricted');

    const broken = fakePage();
    const brokenRun = buildLoop(broken, 'fill the form');
    broken.scan = async () => {
      throw new Error('channel closed');
    };
    const result = await brokenRun.run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('SCAN_FAILED');
  });

  it('reports planner failure and rejected actions without retries', async () => {
    const failing = fakePage();
    failing.scan = async () => ({
      pageText: `Reach me at ${CANARY_EMAIL}`,
      snapshot: null,
      structure: [{ tag: 'input', selector: '#email', inputType: 'email', label: 'Email', disabled: false }],
    });
    // Use the real loop with a gateway that throws — planner failures stop the loop.
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault,
      gateway: { plan: async () => { throw new Error('boom'); } },
      bridge: createActionBridge({ vault, sendToPage: failing.executor }),
      firewall: createPrivacyFirewall(),
      scan: failing.scan,
    });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('PLANNER_FAILED');

    const rejecting = fakePage();
    rejecting.scan = async () => ({
      pageText: `Reach me at ${CANARY_EMAIL}`,
      snapshot: null,
      structure: [{ tag: 'input', selector: '#missing', inputType: 'email', label: 'Email', disabled: false }],
    });
    // ONE shared vault between loop (writes aliases) and bridge (resolves them) — the
    // same constraint the panel must honor.
    const sharedVault = createLocalVault();
    const rejected = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault: sharedVault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault: sharedVault, sendToPage: rejecting.executor }),
      firewall: createPrivacyFirewall(),
      scan: rejecting.scan,
    });
    expect(rejected.status).toBe('error');
    expect(rejected.reason).toBe('NOT_FOUND');
  });

  it('stops at the step budget and flags a no-progress repeat', async () => {
    const scrolling = fakePage();
    let amount = 0;
    const vault = createLocalVault();
    const varying = await runAgentLoop({
      task: 'scroll around',
      sessionId: 's',
      vault,
      gateway: { plan: async () => [{ action: 'SCROLL', amount: (amount += 100) }] },
      bridge: createActionBridge({ vault, sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scrolling.scan,
      maxSteps: 4,
    });
    expect(varying.status).toBe('max_steps');
    expect(varying.steps).toHaveLength(4);

    const stuck = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault: createLocalVault(),
      gateway: { plan: async () => [{ action: 'SCROLL', amount: 100 }] },
      bridge: createActionBridge({ vault: createLocalVault(), sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scrolling.scan,
      maxSteps: 8,
    });
    expect(stuck.status).toBe('max_steps');
    expect(stuck.reason).toBe('NO_PROGRESS');
  });

  it('rejects an empty task', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, '   ');
    expect((await run()).status).toBe('error');
  });
});

describe('toSanitizedNodes', () => {
  it('gates labels/names through the PII detector and never carries values', () => {
    const nodes = toSanitizedNodes([
      { tag: 'input', selector: '#a', label: 'Email', name: 'email', value: CANARY_EMAIL, disabled: false },
      { tag: 'input', selector: '#b', label: `Owner ${CANARY_EMAIL}`, value: 'typed text', disabled: false },
      { tag: 'button', selector: '#c', label: 'Submit', disabled: false },
    ]);
    const [plain, gated, button] = nodes;
    expect(plain).toMatchObject({ selector: '#a', label: 'Email', name: 'email', filled: true });
    expect(plain).not.toHaveProperty('value');
    expect(gated?.label).toBeUndefined();
    expect(gated?.filled).toBe(true);
    expect(button).toMatchObject({ tag: 'button', label: 'Submit', filled: false });
  });
});
