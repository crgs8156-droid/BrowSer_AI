import { describe, expect, it, vi } from 'vitest';
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
    // The vault held the alias→value mapping DURING the run (executor got reals)…
    // …but the mapping is wiped after the run — values must not persist tasks.
    expect(await vault.resolve('USER_EMAIL_1')).toBeUndefined();
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

    // Repeated TYPE (not SCROLL — scrolling is exempt, it is progress-seeking).
    const stuck = await runAgentLoop({
      task: 'fill the form',
      sessionId: 's',
      vault: createLocalVault(),
      gateway: { plan: async () => [{ action: 'TYPE', target: '#email', value: 'hello' }]},
      bridge: createActionBridge({ vault: createLocalVault(), sendToPage: async () => ({ ok: true, code: 'OK' }) }),
      firewall: createPrivacyFirewall(),
      scan: scrolling.scan,
      maxSteps: 8,
    });
    expect(stuck.status).toBe('max_steps');
    expect(stuck.reason).toBe('NO_PROGRESS');
  });

  it('scrolls to below-fold fields, fills them, and completes without tripping the guard', async () => {
    const state = { email: '', submitted: false };
    const page: {
      scrollY: number;
      scan: () => Promise<ScanPageResponse>;
      executor: (action: import('../../extension/src/types/contracts').AgentAction) => Promise<{ ok: boolean; code?: string }>;
    } = {
      scrollY: 0,
      scan: async () => {
        const emailTop = 1600 - page.scrollY;
        return {
          pageText: `Contact: BENCH_EMAIL_001@example.test\n${state.email}`,
          snapshot: { url: 'https://site.test/form', viewport: { width: 1280, height: 800 }, domTextLength: 0, candidates: [] },
          structure: [
            {
              tag: 'input',
              selector: '#email',
              inputType: 'email',
              label: 'Email',
              value: state.email || undefined,
              disabled: false,
              belowFold: emailTop >= 800,
            },
            {
              tag: 'button',
              selector: '#submit',
              label: 'Submit',
              disabled: state.submitted,
              belowFold: 1750 - page.scrollY >= 800,
            },
          ],
        };
      },
      executor: async (action) => {
        if (action.action === 'SCROLL') {
          page.scrollY += action.amount;
          return { ok: true, code: 'OK' };
        }
        if (action.action === 'TYPE' && action.target === '#email') {
          state.email = action.value;
          return { ok: true, code: 'OK' };
        }
        if (action.action === 'CLICK' && action.target === '#submit') {
          state.submitted = true;
          return { ok: true, code: 'OK' };
        }
        return { ok: false, code: 'NOT_FOUND' };
      },
    };

    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form with my details and submit',
      sessionId: 'scroll-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });

    expect(result.status).toBe('completed');
    expect(state.email).toBe('BENCH_EMAIL_001@example.test');
    expect(state.submitted).toBe(true);
    // The scroll steps really happened through the validated bridge.
    expect(result.steps.filter((step) => step.action?.action === 'SCROLL').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to an allowlisted origin named in the task, then fills the form', async () => {
    let url = 'https://portal.test/start';
    const state = { email: '' };
    const executed: string[] = [];
    const scan = async (): Promise<ScanPageResponse> => {
      const onTarget = url.startsWith('https://privagent.test');
      return {
        pageText: [
          onTarget ? `Checkout — Contact BENCH_EMAIL_001@example.test` : 'Landing page: open privagent.test to continue',
          state.email,
        ]
          .filter((part) => part.length > 0)
          .join('\n'),
        snapshot: { url, viewport: { width: 1280, height: 800 }, domTextLength: 0, candidates: [] },
        structure: onTarget
          ? [
              {
                tag: 'input',
                selector: '#email',
                inputType: 'email',
                label: 'Email',
                value: state.email || undefined,
                disabled: false,
              },
            ]
          : [],
      };
    };
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'open privagent.test and fill the form with my details',
      sessionId: 'nav-session',
      vault,
      gateway: createDeterministicPlanner(),
      bridge: createActionBridge({
        vault,
        policy: { navigationAllowlist: ['https://privagent.test'], maxScroll: 10_000 },
        sendToPage: async (action) => {
          executed.push(action.action);
          if (action.action === 'NAVIGATE') {
            url = action.url;
            return { ok: true, code: 'OK' };
          }
          if (action.action === 'TYPE' && action.target === '#email') {
            state.email = action.value;
            return { ok: true, code: 'OK' };
          }
          return { ok: false, code: 'NOT_FOUND' };
        },
      }),
      firewall: createPrivacyFirewall(),
      scan,
      navigationAllowlist: ['https://privagent.test'],
    });

    expect(result.status).toBe('completed');
    expect(executed[0]).toBe('NAVIGATE');
    expect(executed).toContain('TYPE');
    expect(result.steps[0]?.action).toEqual({ action: 'NAVIGATE', url: 'https://privagent.test' });
  });

  it('passes the provider hint through to the outbound request', async () => {
    const seenRequests: import('../../extension/src/types/contracts').RemoteAgentRequest[] = [];
    const page = fakePage();
    const vault = createLocalVault();
    const result = await runAgentLoop({
      task: 'fill the form with my details and submit',
      sessionId: 'provider-session',
      vault,
      provider: 'ollama',
      gateway: {
        plan: async (request) => {
          seenRequests.push(request);
          return createDeterministicPlanner().plan(request);
        },
      },
      bridge: createActionBridge({ vault, sendToPage: page.executor }),
      firewall: createPrivacyFirewall(),
      scan: page.scan,
    });
    expect(result.status).toBe('completed');
    expect(seenRequests[0]?.provider).toBe('ollama');
  });

  it('rejects an empty task', async () => {
    const page = fakePage();
    const { run } = buildLoop(page, '   ');
    expect((await run()).status).toBe('error');
  });
});

describe('vault wipe after every run', () => {
  it('wipes alias mappings when the run completes', async () => {
    const page = fakePage();
    const { run, vault } = buildLoop(page, 'fill the form with my details and submit');
    const spy = vi.spyOn(vault, 'clearSession');

    const result = await run();

    expect(result.status).toBe('completed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('test-session');
    expect(await vault.resolve('USER_EMAIL_1')).toBeUndefined();
    expect(await vault.resolve('USER_PHONE_1')).toBeUndefined();
  });

  it('wipes alias mappings when the run fails', async () => {
    const page = fakePage();
    const inner = page.scan;
    page.scan = async () => ({
      ...(await inner()),
      pageText: 'password: hunter2hunter2',
    });
    const { run, vault } = buildLoop(page, 'fill the form');
    const spy = vi.spyOn(vault, 'clearSession');

    const result = await run();

    expect(result.status).toBe('blocked');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('test-session');
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

  it('normalizes exotic ARIA host tags to div and skips null entries', () => {
    const nodes = toSanitizedNodes([
      { tag: 'li', selector: '#r1', label: 'More', disabled: false },
      { tag: 'img', selector: '#r2', label: 'Photo', disabled: false },
      { tag: 'input', selector: '#a', label: 'Email', disabled: false },
      null,
    ] as unknown as Parameters<typeof toSanitizedNodes>[0]);
    expect(nodes.map((n) => n.tag)).toEqual(['div', 'div', 'input']);
    expect(nodes.every((n) => n.selector.length > 0)).toBe(true);
  });

  it('coerces undefined disabled (ARIA non-form elements) so Google-class pages pass the firewall', async () => {
    // The content script reads `.disabled` off EVERY element, but only form
    // controls have that property — an ARIA div arrives with disabled: undefined,
    // which used to MALFORMED the entire payload (live: node index 1 of 63).
    const structure = [
      { tag: 'input', selector: '#q', label: 'Search', value: '', disabled: false },
      { tag: 'div', selector: '#r1', label: 'All', disabled: undefined },
    ] as unknown as Parameters<typeof toSanitizedNodes>[0];
    const nodes = toSanitizedNodes(structure);
    expect(nodes[1]).toMatchObject({ tag: 'div', disabled: false });
    const verdict = await createPrivacyFirewall().inspect({
      taskObjective: 'summarize this page',
      pageOrigin: 'https://www.google.com',
      sanitizedPageStructure: nodes,
      sanitizedVisibleText: 'Search results',
      aliases: [],
      availableActions: ['CLICK', 'TYPE', 'SELECT', 'SCROLL', 'NAVIGATE'],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
    });
    expect(verdict).toEqual({ allowed: true, reason: 'OK' });
  });

  it('skips selector-less nodes instead of emitting firewall-rejected shapes', () => {
    const nodes = toSanitizedNodes([
      { tag: 'input', selector: '', label: 'Nope', disabled: false },
      { tag: 'input', selector: '#ok', label: 'Fine', disabled: false },
    ] as unknown as Parameters<typeof toSanitizedNodes>[0]);
    expect(nodes.map((n) => n.selector)).toEqual(['#ok']);
  });
});
