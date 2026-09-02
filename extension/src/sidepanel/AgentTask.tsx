// M6 — side-panel agent task UI.
//
// Thin view over `runAgentLoop`: a task input, a run button, and the structured step
// log (action kind + target + outcome code). The panel NEVER renders raw page content —
// step records are alias-level by contract (`AgentStepRecord.action` holds aliases, and
// alias→value resolution happens inside the bridge at execution time, on-device).

import { useState } from 'react';
import { runAgentLoop, type AgentRunResult, type AgentStepRecord } from '../agent';
import { createRemoteHttpAgentGateway } from '../agent/remote';
import { createActionBridge } from '../actions';
import { createPrivacyFirewall } from '../firewall';
import { createDeterministicPlanner } from '../agent/planner';
import { getNavigationAllowlist } from '../agent/session-policy';
import { DEFAULT_ACTION_POLICY } from '../actions/validate';
import { createLocalVault } from '../vault';
import { SCAN_PAGE, type ScanPageResponse } from '../types/messages';
import { recordEvent, sessionTelemetry } from './telemetry-session';

type RunState = 'idle' | 'running' | 'done';

/** Backend planner endpoint (AGENT_PROVIDER=gemini on the FastAPI service). */
const REMOTE_PLAN_ENDPOINT = 'http://localhost:8000/v1/plan';

const STATUS_TEXT: Record<AgentRunResult['status'], string> = {
  completed: '✓ Task completed',
  max_steps: '⏹ Step budget reached',
  blocked: '⛔ Blocked — critical data on page (fail-closed)',
  restricted: '⚠️ Restricted page',
  not_enforced: '⚠️ Could not fully sanitize this page — stopped',
  firewall_blocked: '🛡 Firewall blocked the outbound request',
  error: '✕ Task failed',
};

export function AgentTask() {
  const [task, setTask] = useState('');
  const [useGemini, setUseGemini] = useState(true);
  const [state, setState] = useState<RunState>('idle');
  const [result, setResult] = useState<AgentRunResult | null>(null);

  const run = async () => {
    if (task.trim().length === 0) return;
    setState('running');
    setResult(null);
    try {
      // NAVIGATE allowlist: user-configured via storage (settings surface later);
      // default EMPTY — the loop then falls back to same-origin-only navigation.
      const stored = (await chrome.storage.sync.get('navigationAllowlist')) as {
        navigationAllowlist?: unknown;
      };
      const allowlist = Array.isArray(stored.navigationAllowlist)
        ? (stored.navigationAllowlist as string[])
        : [];

      // ONE vault shared by enforcement (writes aliases) and the bridge (resolves them) —
      // the alias→value mapping lives only here, in memory, for this run.
      const vault = createLocalVault();
      // ONE firewall shared by the loop gate and the remote gateway's pre-transmit gate.
      const firewall = createPrivacyFirewall();
      // Planner toggle: the remote (Gemini) gateway talks to the FastAPI backend over the
      // SAME fail-closed firewall; the deterministic planner is the offline fallback.
      const gateway = useGemini
        ? createRemoteHttpAgentGateway({ endpoint: REMOTE_PLAN_ENDPOINT, firewall })
        : createDeterministicPlanner();

      const runResult = await runAgentLoop({
        task,
        sessionId: `agent-${Date.now()}`,
        vault,
        gateway,
        navigationAllowlist: allowlist,
        bridge: createActionBridge({
          vault,
          policy: () => ({ ...DEFAULT_ACTION_POLICY, navigationAllowlist: [...getNavigationAllowlist()] }),
          onAliasResolved: (alias) => recordEvent({ type: 'ALIAS_RESOLVED', alias }),
        }),
        firewall,
        scan: () => chrome.runtime.sendMessage({ type: SCAN_PAGE }) as Promise<ScanPageResponse>,
      });
      const { stageMs } = runResult;
      for (const [name, ms] of [
        ['agent.scan', stageMs.scanMs],
        ['agent.enforce', stageMs.enforceMs],
        ['agent.plan', stageMs.planMs],
        ['agent.execute', stageMs.executeMs],
        ['agent.total', stageMs.totalMs],
      ] as const) {
        sessionTelemetry.timing(name, ms);
      }
      recordEvent({ type: 'TASK_RESULT' });
      setResult(runResult);
      setState('done');
    } catch {
      setState('done');
      setResult({
        status: 'error',
        reason: 'LOOP_CRASHED',
        steps: [],
        actionsExecuted: 0,
        stageMs: { scanMs: 0, enforceMs: 0, planMs: 0, executeMs: 0, totalMs: 0 },
      });
    }
  };

  return (
    <section className="mt-6 border-t border-neutral-200 pt-4" aria-label="Agent task">
      <h2 className="text-sm font-semibold">Agent task</h2>
      <p className="mt-1 text-xs text-neutral-500">
        The planner sees sanitized aliases only; values are resolved locally at execution.
      </p>

      <input
        className="mt-2 w-full rounded border border-neutral-300 px-2 py-1 text-sm"
        placeholder="e.g. fill the form with my details and submit"
        value={task}
        onChange={(event) => setTask(event.target.value)}
        disabled={state === 'running'}
      />

      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-600">
        <input
          data-testid="use-gemini"
          type="checkbox"
          checked={useGemini}
          onChange={(event) => setUseGemini(event.target.checked)}
          disabled={state === 'running'}
        />
        Use Gemini AI Planner (localhost:8000)
      </label>

      <button
        className="mt-2 px-4 py-1.5 bg-emerald-600 text-white rounded text-sm disabled:opacity-50"
        onClick={run}
        disabled={state === 'running' || task.trim().length === 0}
      >
        {state === 'running' ? 'Running…' : 'Run agent task'}
      </button>

      {state === 'done' && result !== null && (
        <div className="mt-3" data-testid="agent-result">
          <p
            className={
              result.status === 'completed'
                ? 'font-medium text-green-700'
                : 'font-medium text-red-600'
            }
          >
            {STATUS_TEXT[result.status]}
          </p>
          <p className="text-xs text-neutral-500">
            {result.actionsExecuted} action{result.actionsExecuted === 1 ? '' : 's'} executed
            {result.reason !== undefined && result.status !== 'completed' ? ` · ${result.reason}` : ''}
            {` · ${(result.stageMs.totalMs / 1000).toFixed(1)}s local`}
          </p>
          {result.steps.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-neutral-700" data-testid="agent-steps">
              {result.steps.map((step: AgentStepRecord) => (
                <li key={step.index} className="font-mono">
                  {step.action === null ? (
                    <span>#{step.index} — planner: no further action</span>
                  ) : (
                    <span>
                      #{step.index} — {step.action.action}{' '}
                      {step.action.action === 'SCROLL'
                        ? `(${step.action.amount})`
                        : step.action.action === 'NAVIGATE'
                          ? `(allowlisted url)`
                          : `(${step.action.target})`}{' '}
                      → {step.outcome}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
