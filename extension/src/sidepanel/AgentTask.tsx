// M6 — side-panel agent task UI.
//
// Thin view over `runAgentLoop`: a task input, a run button, and the structured step
// log (action kind + target + outcome code). The panel NEVER renders raw page content —
// step records are alias-level by contract (`AgentStepRecord.action` holds aliases, and
// alias→value resolution happens inside the bridge at execution time, on-device).

import { useEffect, useRef, useState } from 'react';
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
import { formatAgentStep, formatTerminalLine, STEP_LOG_OPENERS } from './agent-step-log';
import { loadTaskState, shouldResumeTask } from '../agent/task-state';

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
  const [plannerMode, setPlannerMode] = useState<'local' | 'gemini' | 'offline'>('local');
  const [state, setState] = useState<RunState>('idle');
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const navResolver = useRef<((approved: boolean) => void) | null>(null);

  const originDisplay = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return 'allowlisted url';
    }
  };

  const run = async (objectiveOverride?: string, sessionIdOverride?: string) => {
    const objective = (objectiveOverride ?? task).trim();
    if (objective.length === 0) return;
    setState('running');
    setResult(null);
    setLiveLog([...STEP_LOG_OPENERS]);
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
      // Planner mode: Local AI (Ollama) and Gemini go through the backend over the SAME
      // fail-closed firewall; Offline uses the in-extension deterministic planner (no
      // network at all). The provider hint lets the backend pick per run without a restart.
      // Optional backend bearer token (build-time `VITE_PRIVAGENT_API_KEY`).
      // Absent = dev mode: requests go without an Authorization header.
      const apiKey = import.meta.env.VITE_PRIVAGENT_API_KEY as string | undefined;
      const gateway =
        plannerMode === 'offline'
          ? createDeterministicPlanner()
          : createRemoteHttpAgentGateway({
              endpoint: REMOTE_PLAN_ENDPOINT,
              firewall,
              ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
            });
      const provider = plannerMode === 'offline' ? undefined : (plannerMode === 'local' ? 'ollama' : 'gemini');

      const sessionId = sessionIdOverride ?? `agent-${Date.now()}`;
      const runResult = await runAgentLoop({
        task: objective,
        sessionId,
        vault,
        gateway,
        provider,
        navigationAllowlist: allowlist,
        bridge: createActionBridge({
          vault,
          policy: () => ({ ...DEFAULT_ACTION_POLICY, navigationAllowlist: [...getNavigationAllowlist()] }),
          onAliasResolved: (alias) => recordEvent({ type: 'ALIAS_RESOLVED', alias }),
        }),
        firewall,
        scan: () => chrome.runtime.sendMessage({ type: SCAN_PAGE }) as Promise<ScanPageResponse>,
        onNavigateConfirm: (url) =>
          new Promise<boolean>((resolve) => {
            navResolver.current = resolve;
            setPendingNav(url);
          }),
        onEvent: (event) => {
          if (event.type === 'STEP') {
            setLiveLog((prev) => [...prev, `\u25B8 Step ${event.index} \u2014 ${event.code}`]);
          } else {
            setLiveLog((prev) => [...prev, formatTerminalLine(event.code, event.code)]);
          }
        },
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
      const lines = runResult.steps.map(formatAgentStep);
      lines.push(formatTerminalLine(runResult.status, runResult.reason));
      setLiveLog((prev) => [...prev, ...lines].slice(-30));
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

  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void (async () => {
      const stored = await loadTaskState();
      if (stored === null || !shouldResumeTask(stored)) return;
      setTask(stored.taskObjective);
      setLiveLog(['Resuming task...']);
      await run(stored.taskObjective, stored.taskId);
    })();
  }, []);

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

      <fieldset className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600">
        <legend className="sr-only">Planner mode</legend>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-local"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'local'}
            onChange={() => setPlannerMode('local')}
            disabled={state === 'running'}
          />
          Local AI (Ollama)
        </label>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-gemini"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'gemini'}
            onChange={() => setPlannerMode('gemini')}
            disabled={state === 'running'}
          />
          Gemini
        </label>
        <label className="flex items-center gap-1">
          <input
            data-testid="planner-mode-offline"
            type="radio"
            name="planner-mode"
            checked={plannerMode === 'offline'}
            onChange={() => setPlannerMode('offline')}
            disabled={state === 'running'}
          />
          Offline
        </label>
      </fieldset>

      <button
        className="mt-2 px-4 py-1.5 bg-emerald-600 text-white rounded text-sm disabled:opacity-50"
        onClick={() => void run()}
        disabled={state === 'running' || task.trim().length === 0}
      >
        {state === 'running' ? 'Running…' : 'Run agent task'}
      </button>

      {liveLog.length > 0 && (
        <ul
          className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-neutral-700"
          data-testid="agent-live-log"
        >
          {liveLog.slice(-10).map((line, i) => (
            <li key={`${i}-${line}`} className="font-mono">
              {line}
            </li>
          ))}
        </ul>
      )}

      {pendingNav !== null && state === 'running' && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs" data-testid="nav-confirm">
          <p>
            Agent wants to navigate to {originDisplay(pendingNav)} — allow? [Yes/No]
          </p>
          <div className="mt-1 flex gap-2">
            <button
              className="rounded bg-emerald-600 px-2 py-0.5 text-white"
              data-testid="nav-confirm-yes"
              onClick={() => {
                navResolver.current?.(true);
                navResolver.current = null;
                setPendingNav(null);
                setLiveLog((prev) => [...prev, '\u{1F310} Navigation approved']);
              }}
            >
              Yes
            </button>
            <button
              className="rounded bg-neutral-300 px-2 py-0.5"
              data-testid="nav-confirm-no"
              onClick={() => {
                navResolver.current?.(false);
                navResolver.current = null;
                setPendingNav(null);
                setLiveLog((prev) => [...prev, '\u26D4 Navigation denied']);
              }}
            >
              No
            </button>
          </div>
        </div>
      )}

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
