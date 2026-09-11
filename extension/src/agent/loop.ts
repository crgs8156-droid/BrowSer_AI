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
// (CONTRIBUTING.md §16), never carrying a raw value (§5 Rule 4).

import type {
  AgentAction,
  RemoteAgentRequest,
  SanitizedNode,
} from '../types/contracts';
import type { ScanPageResponse } from '../types/messages';
import { ALLOWED_ACTION_KINDS } from '../actions/kinds';
import type { ActionBridge } from '../actions';
import { detectLabeledValues, detectPII } from '../perception/pii';
import { classifyPage } from '../perception/visual/pageClassifier';
import { enforcePrivacy } from '../sanitizer';
import type { LocalVault } from '../vault';
import type { PrivacyFirewall } from '../firewall';
import type { AgentGateway } from './index';
import { setNavigationAllowlist } from './session-policy';
import { getProgressFingerprint } from './progress';
import { classifyRisk } from './risk';
import type { RiskLevel } from './risk';
import { saveTaskState } from './task-state';

/** One executed step, recorded for the UI/audit. Alias-level only — never a resolved value. */
export interface AgentStepRecord {
  index: number;
  /** The action AS PLANNED (aliases, not values). Null on terminal steps. */
  action: AgentAction | null;
  /** 'executed', or the structured reason the loop stopped. */
  outcome: string;
  ok: boolean;
  /** Non-blocking risk annotation (observability only; never gates execution). */
  risk?: RiskLevel;
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
  /**
   * Planner provider hint passed to the backend (value-free; absent = env default).
   */
  provider?: RemoteAgentRequest['provider'];
  /**
   * NAVIGATE allowlist (validated origins). DEFAULT: the scanned page's own origin —
   * "navigation may stay on the site the user is on" — derived from the snapshot URL
   * (origin only, never the full URL). Empty when no origin is known (fail closed).
   */
  navigationAllowlist?: string[];
  /** Observe the active tab (wraps the SCAN_PAGE relay). Injectable for tests. */
  scan: () => Promise<ScanPageResponse>;
  /** Privacy-event sink (telemetry lands in M7; the loop only emits structured events). */
  onEvent?: (event: { type: 'STEP' | 'STOP'; code: string; index: number }) => void;
}

export const AUTONOMOUS_MAX_STEPS = 10;

const DEFAULT_MAX_STEPS = AUTONOMOUS_MAX_STEPS;

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
    if (field.belowFold === true) {
      node.belowFold = true;
    }
    if (field.name !== undefined && detectPII(field.name).length === 0) {
      node.name = field.name;
    }
    out.push(node);
  }
  return out;
}

async function runLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const steps: AgentStepRecord[] = [];
  let previousFingerprint: string | null = null;
  let actionsExecuted = 0;
  const stage = { scanMs: 0, enforceMs: 0, planMs: 0, executeMs: 0 };
  const startedAt = performance.now();

  // Every terminal path funnels through stop() — completed, blocked, error, or
  // budget-exhausted. The vault wipe lives in the `runAgentLoop` finally belt
  // below (covers this funnel AND unexpected escapes); nothing after a stop()
  // call touches the vault, so the wipe never runs mid-run.
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
    // M7.5 — page-type classification (payment/auth pages force a SANITIZE floor).
    const visualContext = classifyPage(observed.structure, observed.pageText);
    const enforceStartedAt = performance.now();
    const enforcement = await enforcePrivacy({
      signals: { entities, visualContext, restricted: false },
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

    // Navigation allowlist: explicit option wins; otherwise the scanned page's own
    // origin (same-site navigation only). Shared with the bridge's policy provider.
    let allowlist = options.navigationAllowlist ?? [];
    if (options.navigationAllowlist === undefined && observed.snapshot?.url) {
      try {
        allowlist = [new URL(observed.snapshot.url).origin];
      } catch {
        allowlist = [];
      }
    }
    setNavigationAllowlist(allowlist);

    let pageOrigin: string | undefined;
    if (observed.snapshot?.url) {
      try {
        pageOrigin = new URL(observed.snapshot.url).origin;
      } catch {
        pageOrigin = undefined;
      }
    }

    // 3 — build the sanitized request.
    const request: RemoteAgentRequest = {
      taskObjective: options.task,
      pageOrigin,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      sanitizedPageStructure: toSanitizedNodes(observed.structure),
      sanitizedVisibleText: enforcement.sanitizedText,
      aliases: enforcement.aliases,
      availableActions: [...ALLOWED_ACTION_KINDS],
      policy: { privacyMode: 'strict', navigationAllowlist: allowlist },
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
    const risk = classifyRisk(action);
    steps.push({ index, action, outcome, ok, risk });
    options.onEvent?.({ type: 'STEP', code: outcome, index });

    // Best-effort safe task persistence (session-only, alias-level, never values).
    try {
      await saveTaskState({
        taskId: options.sessionId,
        taskObjective: options.task,
        currentStep: index + 1,
        steps: steps.map((s) => ({
          index: s.index,
          action: s.action ? s.action.action : null,
          outcome: s.outcome,
          ok: s.ok,
        })),
        status: 'running',
        updatedAt: Date.now(),
      });
    } catch {
      // ignore - persistence is best-effort
    }

    if (!ok) return stop('error', outcome);

    // Navigation settle: the tab is loading a new document; give it a moment before
    // the next observation (the scan relay's own injection retries handle the rest).
    if (action.action === 'NAVIGATE') {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }

    // No-progress guard: executing the identical NON-SCROLL action twice in a row means
    // the page state is not changing under us (e.g. a submit button that stays
    // enabled). Repeated scrolls are legitimate progress toward below-fold controls
    // (the re-observation decides when to stop scrolling), so they are exempt — the
    // step budget still bounds them.
    const fingerprint = getProgressFingerprint(
      toSanitizedNodes(observed.structure),
      pageOrigin,
      action,
    );
    const fingerprintStalled =
      previousFingerprint !== null &&
      fingerprint === previousFingerprint &&
      action.action !== 'SCROLL';
    previousFingerprint = fingerprint;

    const previous = steps[steps.length - 2];
    const identicalRepeat =
      action.action !== 'SCROLL' &&
      previous !== undefined &&
      previous.ok &&
      previous.action !== null &&
      previous.action.action !== 'SCROLL' &&
      JSON.stringify(previous.action) === JSON.stringify(action);
    if (identicalRepeat || fingerprintStalled) {
      return stop('max_steps', 'NO_PROGRESS');
    }
  }

  return stop('max_steps');
}

/**
 * Public entry point. The `finally` belt covers the one path `stop()` cannot:
 * an exception escaping the loop body itself (e.g. enforcement throwing outside
 * any guarded await). The vault is wiped even on an unexpected crash — values
 * must not survive a crashed run. Double-wipe with `stop()` is a harmless no-op.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  try {
    return await runLoop(options);
  } finally {
    try {
      await options.vault.clearSession?.(options.sessionId);
    } catch {
      // Best-effort cleanup; mappings die with the context regardless.
    }
  }
}

type ExecuteOutcome = string;
