// M6 — the agent loop driver (blueprint §7/§9).
//
// One step = observe → enforce → sanitize → firewall → plan → execute:
//
//   SCAN_PAGE (structured inputs, raw, internal only)
//     → detectPII (M2) → enforcePrivacy (M4+M5: aliasing into the LOCAL vault)
//     → build RemoteAgentRequest (SanitizedNodes: filled flags + gated labels, never values)
//     → privacy firewall.inspect (fail closed — the ONLY egress gate, §5 Rule 6)
//     → gateway.plan (deterministic planner or remote provider)
//     → action bridge: schema → policy → LOCAL alias resolution → constrained execution
//     → re-observe (the sanitized page state is the loop's only memory)
//
// Fail-closed stops: blocked page, restricted surface, unenforceable findings, firewall
// deny, planner/execution failure. Each stop is a structured status — never silent
// (CLAUDE.md §16), never carrying a raw value (§5 Rule 4).

import type {
  AgentAction,
  RemoteAgentRequest,
  SanitizedNode,
} from '../types/contracts';
import type { ScanPageResponse } from '../types/messages';
import { ALLOWED_ACTION_KINDS } from '../actions/kinds';
import type { ActionBridge } from '../actions';
import { detectLabeledValues, detectPII } from '../perception/pii';
import { enforcePrivacy } from '../sanitizer';
import type { LocalVault } from '../vault';
import type { PrivacyFirewall } from '../firewall';
import type { AgentGateway } from './index';

/** One executed step, recorded for the UI/audit. Alias-level only — never a resolved value. */
export interface AgentStepRecord {
  index: number;
  /** The action AS PLANNED (aliases, not values). Null on terminal steps. */
  action: AgentAction | null;
  /** 'executed', or the structured reason the loop stopped. */
  outcome: string;
  ok: boolean;
}

export type AgentRunStatus =
  | 'completed'
  | 'max_steps'
  | 'blocked'
  | 'restricted'
  | 'not_enforced'
  | 'firewall_blocked'
  | 'error';

export interface AgentRunResult {
  status: AgentRunStatus;
  /** Non-sensitive detail code for the terminal step (e.g. FIREWALL_PII_DETECTED). */
  reason?: string;
  steps: AgentStepRecord[];
  actionsExecuted: number;
  /**
   * M7 — cumulative local-inference stage timings (ms) across all steps
   * (blueprint §10 "local inference latency"). Durations only, never content.
   */
  stageMs: {
    scanMs: number;
    enforceMs: number;
    planMs: number;
    executeMs: number;
    totalMs: number;
  };
}

export interface AgentLoopOptions {
  task: string;
  maxSteps?: number;
  sessionId: string;
  vault: LocalVault;
  gateway: AgentGateway;
  bridge: ActionBridge;
  firewall: PrivacyFirewall;
  /** Observe the active tab (wraps the SCAN_PAGE relay). Injectable for tests. */
  scan: () => Promise<ScanPageResponse>;
  /** Privacy-event sink (telemetry lands in M7; the loop only emits structured events). */
  onEvent?: (event: { type: 'STEP' | 'STOP'; code: string; index: number }) => void;
}

const DEFAULT_MAX_STEPS = 8;

/**
 * Build the remote-safe `SanitizedNode` list from the raw internal structure. A label or
 * name crosses ONLY when the M2 detector finds nothing in it (fail closed); values never
 * cross at all — a field is just `filled` or not.
 */
export function toSanitizedNodes(structure: ScanPageResponse['structure']): SanitizedNode[] {
  const out: SanitizedNode[] = [];
  for (const field of structure ?? []) {
    const node: SanitizedNode = {
      tag: field.tag,
      selector: field.selector,
      filled: typeof field.value === 'string' && field.value.length > 0,
      disabled: field.disabled,
    };
    if (field.inputType !== undefined && detectPII(field.inputType).length === 0) {
      node.inputType = field.inputType;
    }
    if (field.label !== undefined && detectPII(field.label).length === 0) {
      node.label = field.label;
    }
    if (field.name !== undefined && detectPII(field.name).length === 0) {
      node.name = field.name;
    }
    out.push(node);
  }
  return out;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: AgentStepRecord[] = [];
  let actionsExecuted = 0;
  const stage = { scanMs: 0, enforceMs: 0, planMs: 0, executeMs: 0 };
  const startedAt = performance.now();

  const stop = (status: AgentRunStatus, reason?: string): AgentRunResult => {
    options.onEvent?.({ type: 'STOP', code: reason ?? status, index: steps.length });
    return {
      status,
      reason,
      steps,
      actionsExecuted,
      stageMs: { ...stage, totalMs: performance.now() - startedAt },
    };
  };

  if (typeof options.task !== 'string' || options.task.trim().length === 0) {
    return stop('error', 'EMPTY_TASK');
  }

  for (let index = 0; index < maxSteps; index++) {
    // 1 — observe (raw, internal only).
    let observed: ScanPageResponse;
    const scanStartedAt = performance.now();
    try {
      observed = await options.scan();
    } catch {
      return stop('error', 'SCAN_FAILED');
    }
    stage.scanMs += performance.now() - scanStartedAt;
    if (observed.restricted === true) return stop('restricted');
    if (
      observed.error !== undefined ||
      typeof observed.pageText !== 'string' ||
      !Array.isArray(observed.structure)
    ) {
      return stop('error', observed.error ?? 'SCAN_FAILED');
    }

    // 2 — enforce locally: alias every recoverable value into the LOCAL vault.
    // Multi-signal detection (blueprint §5): pattern evidence (detectPII) + label
    // evidence (detectLabeledValues) — names/addresses/credential-like values that no
    // pattern can catch are still protected, or the leakage sentinel will catch us.
    const entities = [
      ...detectPII(observed.pageText),
      ...detectLabeledValues(observed.pageText),
    ];
    const enforceStartedAt = performance.now();
    const enforcement = await enforcePrivacy({
      signals: { entities, restricted: false },
      pageText: observed.pageText,
      sessionId: options.sessionId,
      vault: options.vault,
    });
    stage.enforceMs += performance.now() - enforceStartedAt;
    // Fail closed: a page we cannot fully neutralize (or that carries a critical
    // credential) never produces an outbound request.
    if (enforcement.blocked) return stop('blocked', 'PAGE_BLOCKED');
    if (enforcement.restricted) return stop('restricted');
    if (!enforcement.enforced) return stop('not_enforced', 'FINDINGS_UNRESOLVED');

    // 3 — build the sanitized request.
    const request: RemoteAgentRequest = {
      taskObjective: options.task,
      sanitizedPageStructure: toSanitizedNodes(observed.structure),
      sanitizedVisibleText: enforcement.sanitizedText,
      aliases: enforcement.aliases,
      availableActions: [...ALLOWED_ACTION_KINDS],
      policy: { privacyMode: 'strict', navigationAllowlist: [] },
    };

    // 4 — firewall: the only path to egress. A deny stops the loop, visibly.
    const verdict = await options.firewall.inspect(request);
    if (!verdict.allowed) return stop('firewall_blocked', verdict.reason);

    // 5 — plan.
    let planned: AgentAction[];
    const planStartedAt = performance.now();
    try {
      planned = await options.gateway.plan(request);
    } catch (error) {
      return stop(
        'error',
        error instanceof Error && error.name === 'FirewallBlockedError'
          ? 'FIREWALL_BLOCKED'
          : 'PLANNER_FAILED',
      );
    }
    stage.planMs += performance.now() - planStartedAt;
    if (planned.length === 0) {
      steps.push({ index, action: null, outcome: 'no_action', ok: true });
      return stop('completed');
    }

    // 6 — execute the first planned action through the full validation bridge.
    const action = planned[0];
    if (action === undefined) {
      steps.push({ index, action: null, outcome: 'no_action', ok: true });
      return stop('completed');
    }
    const executeStartedAt = performance.now();
    let outcome: ExecuteOutcome;
    try {
      const response = await options.bridge.execute(action);
      outcome = response.ok ? 'executed' : (response.code ?? 'EXEC_FAILED');
    } catch {
      outcome = 'EXEC_FAILED';
    }
    stage.executeMs += performance.now() - executeStartedAt;
    const ok = outcome === 'executed';
    if (ok) actionsExecuted++;
    steps.push({ index, action, outcome, ok });
    options.onEvent?.({ type: 'STEP', code: outcome, index });

    if (!ok) return stop('error', outcome);

    // No-progress guard: executing the identical action twice in a row means the page
    // state is not changing under us (e.g. a submit button that stays enabled). Stop
    // honestly instead of looping to the budget.
    const previous = steps[steps.length - 2];
    if (
      previous !== undefined &&
      previous.ok &&
      previous.action !== null &&
      JSON.stringify(previous.action) === JSON.stringify(action)
    ) {
      return stop('max_steps', 'NO_PROGRESS');
    }
  }

  return stop('max_steps');
}

type ExecuteOutcome = string;
