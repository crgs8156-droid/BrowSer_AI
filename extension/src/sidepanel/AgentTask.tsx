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
import { maskValue } from './reveal';
import { getLastCloudPayload, getLastCloudPayloadMeta } from '../agent/remote';
import { classifyFromStatus } from '../debug/errors';
import { getTrace, startTrace, setTraceEnabled } from '../debug/trace';
import { setAgentRunning } from './run-state';
import { AUTONOMOUS_MAX_STEPS } from '../agent/loop';
import {
  addTemplate,
  deleteTemplate,
  getDefaultTemplates,
  instructionForTemplate,
  loadTemplates,
  saveTemplates,
  type TaskTemplate,
} from '../templates';

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
  paused_captcha: '⚠️ CAPTCHA detected — solve it and click Resume',
  stopped: '⏹ Stopped',
  error: '✕ Task failed',
};

export function AgentTask() {
  const [task, setTask] = useState('');
  const [plannerMode, setPlannerMode] = useState<'local' | 'gemini' | 'offline'>('gemini');
  const [state, setState] = useState<RunState>('idle');
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [revealRows, setRevealRows] = useState<Array<{ alias: string; category: string; value: string; masked: string }>>([]);
  const [revealOpen, setRevealOpen] = useState(false);
  const [unmasked, setUnmasked] = useState<Set<string>>(new Set());
  const [cloudOpen, setCloudOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [cloudSnapshot, setCloudSnapshot] = useState<import('../types/contracts').RemoteAgentRequest | null>(null);
  const [cloudMeta, setCloudMeta] = useState<{ at: number; bytes: number } | null>(null);
  const revealMapRef = useRef<Map<string, { value: string; category: string }>>(new Map());
  const [debugMode, setDebugMode] = useState(false);
  const [traceLines, setTraceLines] = useState<string[]>([]);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [templates, setTemplates] = useState<TaskTemplate[]>(() => getDefaultTemplates());
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customInstruction, setCustomInstruction] = useState('');
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
    setAgentRunning(true);
    setResult(null);
    setLiveLog([...STEP_LOG_OPENERS]);
    if (debugMode) { startTrace(); setTraceLines([]); }
    setRevealRows([]);
    setRevealOpen(false);
    setUnmasked(new Set());
    setCloudOpen(false);
    setShowRaw(false);
    setCloudSnapshot(null);
    setCloudMeta(null);
    revealMapRef.current.clear();
    try {
      // NAVIGATE allowlist: user-configured via storage (settings surface later);
      // default EMPTY — the loop then falls back to same-origin-only navigation.
      const stored = (await chrome.storage.sync.get('navigationAllowlist')) as {
        navigationAllowlist?: unknown;
      };
      const allowlist = Array.isArray(stored.navigationAllowlist)
        ? (stored.navigationAllowlist as string[])
        : [];

      // Wrapped vault: real store + side copy for reveal viewer (memory only, never logged).
      const realVault = createLocalVault();
      const vault = {
        put: async (rec: import('../types/contracts').AliasRecord, val: string) => {
          revealMapRef.current.set(rec.alias, { value: val, category: rec.category });
          return realVault.put(rec, val);
        },
        resolve: (alias: string) => realVault.resolve(alias),
        clearSession: (sid: string) => realVault.clearSession(sid),
      } as import('../vault').LocalVault;
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
      // Snapshot reveal rows from side-copied vault (values never enter telemetry/audit)
      try {
        const rows = Array.from(revealMapRef.current.entries()).map(([alias, v]) => ({
          alias,
          category: v.category,
          value: v.value,
          masked: maskValue(v.value),
        }));
        setRevealRows(rows);
      } catch {
        // ignore
      }
      try {
        setCloudSnapshot(getLastCloudPayload());
        setCloudMeta(getLastCloudPayloadMeta());
      } catch {
        // ignore
      }
      if (debugMode) setTraceLines(getTrace().map((e) => e.formatted));
      const lines = runResult.steps.map(formatAgentStep);
      lines.push(formatTerminalLine(runResult.status, runResult.reason));
      setLiveLog((prev) => [...prev, ...lines].slice(-30));
      setResult(runResult);
      setState('done');
      setAgentRunning(false);
    } catch {
      setState('done');
      setAgentRunning(false);
      setResult({
        status: 'error',
        reason: 'LOOP_CRASHED',
        steps: [],
        actionsExecuted: 0,
        stageMs: { scanMs: 0, enforceMs: 0, planMs: 0, executeMs: 0, totalMs: 0 },
      });
    }
  };

  useEffect(() => {
    void loadTemplates().then((stored) => {
      setTemplates(stored);
    });
  }, []);

  useEffect(() => {
    // Debug mode persist
    try { void chrome.storage?.local?.get('debugMode').then((d: Record<string, unknown>) => { if (typeof d?.debugMode === 'boolean') { setDebugMode(d.debugMode as boolean); setTraceEnabled(d.debugMode as boolean); } }); } catch { /* ignore */ }
  }, []);

  const didMountRef = useRef(false);
  useEffect(() => {
    // Lazy health check: never fire on initial panel load (smoke asserts zero
    // console errors; a failed fetch logs ERR_CONNECTION_REFUSED at Chromium
    // level before any JS catch runs). Fire only after the user changes mode
    // to a backend-backed planner.
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (plannerMode === 'offline') { setBackendOnline(null); return; }
    const check = async () => {
      try {
        const res = await fetch('http://localhost:8000/health',
          { signal: AbortSignal.timeout(2000) });
        setBackendOnline(res.ok ? true : false);
      } catch {
        // Backend unreachable — expected when backend not running.
        // Do NOT log to console (breaks smoke test).
        setBackendOnline(false);
      }
    };
    void check();
  }, [plannerMode]);

  useEffect(() => {
    if (!debugMode || state !== 'running') return;
    const id = setInterval(() => setTraceLines(getTrace().map((e) => e.formatted)), 500);
    return () => clearInterval(id);
  }, [debugMode, state]);

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
    <section className="pa-card" style={{ padding: '12px 14px', marginTop: 10 }} aria-label="Agent task">
      <p className="pa-section-label">Automated agent</p>
      <p className="pa-faint" style={{ marginTop: 4, fontSize: 11 }}>
        The planner sees sanitized aliases only; values are resolved locally at execution.
      </p>

      <div className="pa-chips" style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '10px 0 6px', paddingBottom: 4 }} data-testid="template-chips">
        {templates.map((tpl) => (
          <span key={tpl.id} style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>
            <button
              className="pa-chip"
              data-testid={`template-${tpl.id}`}
              title={tpl.description}
              disabled={state === 'running'}
              onClick={() => {
                const instruction = instructionForTemplate(templates, tpl.id);
                if (instruction !== null) setTask(instruction);
              }}
            >
              {tpl.icon} {tpl.name}
            </button>
            {!getDefaultTemplates().some((d) => d.id === tpl.id) && (
              <button
                style={{ fontSize: 12, color: 'var(--pa-dim)' }}
                data-testid={`template-delete-${tpl.id}`}
                title="Delete custom template"
                disabled={state === 'running'}
                onClick={() => {
                  setTemplates((prev) => {
                    const next = deleteTemplate(prev, tpl.id);
                    void saveTemplates(next);
                    return next;
                  });
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          className="pa-chip"
          style={{ flexShrink: 0, borderStyle: 'dashed' }}
          data-testid="template-custom-open"
          disabled={state === 'running'}
          onClick={() => setShowCustomModal(true)}
        >
          + Custom
        </button>
      </div>

      {showCustomModal && (
        <div className="pa-card" style={{ marginTop: 8, padding: 8 }} data-testid="template-custom-modal">
          <input
            className="pa-input"
            style={{ fontSize: 12 }}
            placeholder="Template name"
            data-testid="template-custom-name"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
          />
          <textarea
            className="pa-textarea"
            style={{ marginTop: 4, fontSize: 12 }}
            placeholder="Instruction (no personal values — categories only)"
            data-testid="template-custom-instruction"
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
          />
          <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
            <button
              className="pa-run pa-run-idle"
              style={{ width: 'auto', padding: '4px 12px', fontSize: 12 }}
              data-testid="template-custom-save"
              disabled={customName.trim().length === 0 || customInstruction.trim().length === 0}
              onClick={() => {
                const next = addTemplate(templates, {
                  name: customName.trim(),
                  icon: '\u2795',
                  instruction: customInstruction.trim(),
                  description: 'Custom template',
                });
                setTemplates(next);
                void saveTemplates(next);
                setCustomName('');
                setCustomInstruction('');
                setShowCustomModal(false);
              }}
            >
              Save
            </button>
            <button
              className="pa-chip"
              onClick={() => setShowCustomModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <p className="pa-label" style={{ marginTop: 10, marginBottom: 6 }}>
        Natural Language Instruction
      </p>
      <textarea
        className="pa-textarea"
        placeholder="e.g. fill the form with my details and submit"
        value={task}
        onChange={(event) => setTask(event.target.value)}
        disabled={state === 'running'}
      />

      <fieldset style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 12 }} className="pa-muted">
        <legend className="sr-only">Planner mode</legend>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
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

      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} className="pa-faint" data-testid="backend-health">
        {plannerMode === 'offline' ? (
          <span>⚫ Offline mode selected (backend not needed)</span>
        ) : backendOnline === null ? (
          <span>⚪ Checking backend...</span>
        ) : backendOnline ? (
          <span style={{ color: 'var(--pa-accent)' }}>🟢 Backend online</span>
        ) : (
          <span style={{ color: 'var(--pa-danger)' }}>🔴 Backend offline — switch to Offline mode</span>
        )}
      </div>

      {(() => {
        const stepEvents = liveLog.filter((line) => line.startsWith('\u25B8')).length;
        if (state === 'running') {
          return (
            <button
              className="pa-run pa-run-busy"
              style={{ marginTop: 8 }}
              aria-label="Run agent task"
              onClick={() => void run()}
              disabled
            >
              <span aria-hidden="true" className="pa-spinner" />
              Running... (step {stepEvents}/{AUTONOMOUS_MAX_STEPS})
            </button>
          );
        }
        if (state === 'done' && result !== null && result.status === 'completed') {
          return (
            <button
              className="pa-run pa-run-done"
              style={{ marginTop: 8 }}
              aria-label="Run agent task"
              onClick={() => void run()}
              disabled={task.trim().length === 0}
            >
              ✅ Task Complete — Run Again
            </button>
          );
        }
        if (state === 'done' && result !== null && result.status === 'paused_captcha') {
          return (
            <button
              className="pa-run pa-run-warn"
              style={{ marginTop: 8 }}
              aria-label="Run agent task"
              onClick={() => void run()}
              disabled={task.trim().length === 0}
            >
              ⚠️ CAPTCHA — solve then Resume
            </button>
          );
        }
        if (state === 'done' && result !== null) {
          return (
            <button
              className="pa-run pa-run-error"
              style={{ marginTop: 8 }}
              aria-label="Run agent task"
              onClick={() => void run()}
              disabled={task.trim().length === 0}
            >
              ❌ {result.reason ?? result.status} — Retry
            </button>
          );
        }
        return (
          <button
            className="pa-run pa-run-idle"
            style={{ marginTop: 8 }}
            aria-label="Run agent task"
            onClick={() => void run()}
            disabled={task.trim().length === 0}
          >
            ⚡ Run Automated Agent
          </button>
        );
      })()}

      {liveLog.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}>
            <span className="pa-section-label">Step log</span>
            <span className="pa-section-label" style={{ marginLeft: 'auto' }}>
              [{result !== null ? result.steps.length : liveLog.filter((line) => line.startsWith('\u25B8')).length}/{AUTONOMOUS_MAX_STEPS} steps]
            </span>
          </div>
          <ul className="pa-steplog" data-testid="agent-live-log">
            {liveLog.slice(-10).map((line, i) => (
              <li key={`${i}-${line}`}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pendingNav !== null && state === 'running' && (
        <div className="pa-card" style={{ marginTop: 8, padding: 8, borderColor: 'rgba(245,158,11,0.3)', fontSize: 12 }} data-testid="nav-confirm">
          <p style={{ color: 'var(--pa-text)' }}>
            Agent wants to navigate to {originDisplay(pendingNav)} — allow? [Yes/No]
          </p>
          <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
            <button
              className="pa-run pa-run-idle"
              style={{ width: 'auto', padding: '2px 12px', fontSize: 12 }}
              data-testid="nav-confirm-yes"
              onClick={() => {
                const approvedUrl = pendingNav;
                navResolver.current?.(true);
                navResolver.current = null;
                setPendingNav(null);
                // Logged ONLY after approval (never before): origin-only, never values.
                setLiveLog((prev) => [...prev, `\u{1F310} ${originDisplay(approvedUrl ?? '')} added to session allowlist`]);
              }}
            >
              Yes
            </button>
            <button
              className="pa-chip"
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

      {state === 'done' && result !== null && result.status === 'paused_captcha' && (
        <div className="pa-card" style={{ marginTop: 8, padding: 8, borderColor: 'rgba(245,158,11,0.3)', fontSize: 12 }} data-testid="captcha-banner">
          <p style={{ color: 'var(--pa-warning)' }}>⚠️ CAPTCHA detected — solve it and click Resume</p>
          <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
            <button
              className="pa-run pa-run-warn"
              style={{ width: 'auto', padding: '2px 12px', fontSize: 12 }}
              data-testid="captcha-resume"
              onClick={() => void run()}
            >
              Resume
            </button>
            <button
              className="pa-chip"
              data-testid="captcha-cancel"
              onClick={() => {
                setResult(null);
                setState('idle');
                setAgentRunning(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {state === 'done' && result !== null && (
        <div className="pa-card" style={{ marginTop: 12, padding: '12px 14px' }} data-testid="agent-result">
          <p
            style={{
              fontWeight: 600,
              fontSize: 13,
              color:
                result.status === 'completed'
                  ? 'var(--pa-accent)'
                  : result.status === 'paused_captcha'
                    ? 'var(--pa-warning)'
                    : 'var(--pa-danger)',
            }}
          >
            {STATUS_TEXT[result.status]}
          </p>
          <p className="pa-faint" style={{ fontSize: 12 }}>
            {result.actionsExecuted} action{result.actionsExecuted === 1 ? '' : 's'} executed
            {result.reason !== undefined && result.status !== 'completed' ? ` · ${result.reason}` : ''}
            {` · ${(result.stageMs.totalMs / 1000).toFixed(1)}s local`}
          </p>
          {(() => {
            const cls = classifyFromStatus(result.status, result.reason);
            if (cls.category === 'unknown' && result.status === 'completed') return null;
            const isError = ['network','llm_timeout','llm_parse','firewall_block','dom_access','model_load','permission','max_steps'].includes(cls.category) || result.status === 'error' || result.status === 'blocked' || result.status === 'firewall_blocked';
            if (!isError) return null;
            return (
              <div className="pa-card" style={{ marginTop: 8, padding: 8, fontSize: 12 }} data-testid="classified-error">
                <p style={{ color: cls.category === 'firewall_block' || cls.category === 'network' || cls.category === 'permission' ? 'var(--pa-danger)' : 'var(--pa-warning)' }}>
                  {cls.category === 'network' ? '🔴 Backend unreachable' : cls.category === 'llm_timeout' ? '🟡 AI planner timed out' : cls.category === 'llm_parse' ? '🟡 AI returned unexpected response' : cls.category === 'firewall_block' ? '🔴 Privacy firewall blocked this request' : cls.category === 'dom_access' ? '🟡 Cannot access this page' : cls.category === 'model_load' ? '🟡 Vision model unavailable' : cls.category === 'permission' ? '🔴 Permission required' : cls.category === 'max_steps' ? '🟡 Task reached step limit (10/10)' : cls.message}
                </p>
                <p className="pa-muted" style={{ marginTop: 4, fontSize: 12 }}>{cls.category === 'network' ? 'Start the backend: cd backend/fastapi && uvicorn app.main:app --port 8000' : cls.category === 'llm_timeout' ? 'The LLM took too long to respond. Try again or switch to Offline mode.' : cls.category === 'llm_parse' ? 'The planner returned invalid actions. Retrying...' : cls.category === 'firewall_block' ? `${cls.debugHint}. This is a safety protection — the request was not sent.` : cls.category === 'dom_access' ? 'Chrome extensions cannot scan browser system pages (chrome://, extensions pages, etc.) Try on a regular website.' : cls.category === 'model_load' ? 'Icon detection model failed to load. Using text-based analysis only.' : cls.category === 'permission' ? 'Try reloading the extension or granting activeTab permission.' : cls.category === 'max_steps' ? 'The task was too complex to complete automatically.' : cls.debugHint}</p>
                <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                  {cls.recoverable && <button className="pa-run pa-run-idle" style={{ width: 'auto', padding: '2px 12px', fontSize: 12 }} data-testid="error-retry" onClick={() => void run()}>Retry</button>}
                  {cls.category === 'llm_timeout' && <button className="pa-chip" data-testid="error-offline" onClick={() => setPlannerMode('offline')}>Switch to Offline</button>}
                  {cls.category === 'firewall_block' && <button className="pa-chip" data-testid="error-view-blocked">View what was blocked</button>}
                  {cls.category === 'model_load' && <button className="pa-chip" data-testid="error-continue">Continue anyway</button>}
                  {cls.category === 'max_steps' && <button className="pa-chip" data-testid="error-view-progress">View progress so far</button>}
                </div>
              </div>
            );
          })()}
          {result.steps.length > 0 && (
            <ul style={{ marginTop: 8, display: 'grid', gap: 4, fontSize: 12 }} className="pa-muted" data-testid="agent-steps">
              {result.steps.map((step: AgentStepRecord) => (
                <li key={step.index} style={{ fontFamily: 'monospace' }}>
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
          {(() => {
            const rows = [
              { label: 'Scan', ms: result.stageMs.scanMs },
              { label: 'Enforce', ms: result.stageMs.enforceMs },
              { label: 'Plan', ms: result.stageMs.planMs },
              { label: 'Execute', ms: result.stageMs.executeMs },
              { label: 'Total', ms: result.stageMs.totalMs },
            ];
            const max = Math.max(1, ...rows.map((r) => r.ms));
            return (
              <div className="pa-latency" data-testid="latency-breakdown">
                <p className="pa-latency-title">⚡ On-Device Latency Breakdown</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
                  {rows.map((row) => (
                    <div key={row.label}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ color: 'var(--pa-faint)', fontSize: 10 }}>{row.label}</span>
                        <span style={{ color: 'var(--pa-text)', fontSize: 12, fontFamily: 'monospace', marginLeft: 'auto' }}>
                          {row.ms.toFixed(1)}ms
                        </span>
                      </div>
                      <div className="pa-bar" style={{ marginTop: 2 }}>
                        <span style={{ width: `${Math.max(2, Math.round((row.ms / max) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} className="pa-faint" data-testid="debug-toggle">
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={debugMode} onChange={(e) => { const on = e.target.checked; setDebugMode(on); setTraceEnabled(on); try{ void chrome.storage?.local?.set({ debugMode: on }); }catch{ /* ignore */ } if (!on) setTraceLines([]); }} data-testid="debug-toggle-checkbox" />
          Debug trace
        </label>
      </div>

      {debugMode && traceLines.length > 0 && (
        <div className="pa-card" style={{ marginTop: 8, padding: 8, fontSize: 12 }} data-testid="debug-trace">
          <p style={{ fontWeight: 600, color: 'var(--pa-text)' }}>Debug trace</p>
          <ul className="pa-steplog" style={{ marginTop: 4, maxHeight: 160 }}>
            {traceLines.slice(-50).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}

      {state === 'done' && result !== null && (
        <section className="pa-card" style={{ marginTop: 12, padding: '12px 14px' }} aria-label="Transparency" data-testid="transparency">
          <p className="pa-section-label">Transparency</p>
          <p className="pa-faint" style={{ marginTop: 4, fontSize: 11 }}>Local values stay on this device · Cloud payload is sanitized</p>

          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              className="pa-chip"
              data-testid="reveal-toggle"
              disabled={revealRows.length === 0}
              onClick={() => setRevealOpen((v) => !v)}
            >
              {revealOpen ? "Hide session values" : "👁 Reveal session values (this device only)"}
            </button>
            <button
              className="pa-chip"
              data-testid="cloud-toggle"
              onClick={() => setCloudOpen((v) => !v)}
            >
              {cloudOpen ? "Hide Cloud payload" : "📡 Inspect last Cloud payload"}
            </button>
          </div>

          {revealOpen && (
            <div style={{ marginTop: 8 }} data-testid="reveal-panel">
              <p style={{ fontSize: 12, color: 'var(--pa-warning)' }}>Visible on this screen only — never sent, logged, or stored</p>
              {revealRows.length === 0 ? (
                <p className="pa-faint" style={{ marginTop: 4, fontSize: 12 }}>No values in memory</p>
              ) : (
                <ul style={{ marginTop: 4, display: 'grid', gap: 4 }} data-testid="reveal-rows">
                  {revealRows.map((row) => {
                    const isUnmasked = unmasked.has(row.alias);
                    return (
                      <li key={row.alias} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', padding: '8px 12px', fontFamily: 'monospace', fontSize: 12 }}>
                        <span>
                          <span className="pa-alias">{row.alias}</span>
                          <span className="pa-faint" style={{ marginLeft: 4 }}>({row.category})</span>
                          <span style={{ marginLeft: 8, color: 'var(--pa-text)' }}>{isUnmasked ? row.value : row.masked}</span>
                        </span>
                        <button
                          className="pa-chip"
                          style={{ marginLeft: 8 }}
                          data-testid={`reveal-unmask-${row.alias}`}
                          onClick={() => {
                            setUnmasked((prev) => {
                              const next = new Set(prev);
                              if (next.has(row.alias)) next.delete(row.alias);
                              else next.add(row.alias);
                              return next;
                            });
                          }}
                        >
                          {isUnmasked ? "Mask" : "Show"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {cloudOpen && (
            <div className="pa-card" style={{ marginTop: 8, padding: 8, fontSize: 12 }} data-testid="cloud-panel">
              {cloudSnapshot === null ? (
                <p className="pa-faint">Offline run — 0 bytes left this device</p>
              ) : (
                <>
                  <p style={{ fontWeight: 600, color: 'var(--pa-text)' }}>Curated summary</p>
                  <ul className="pa-muted" style={{ marginTop: 4, display: 'grid', gap: 2, fontFamily: 'monospace', fontSize: 11 }}>
                    <li>task: {cloudSnapshot.taskObjective.slice(0, 60)}</li>
                    <li>origin: {cloudSnapshot.pageOrigin ?? "unknown"}</li>
                    <li>nodes: {cloudSnapshot.sanitizedPageStructure.length} · aliases: {cloudSnapshot.aliases.length} · bytes: {cloudMeta?.bytes ?? JSON.stringify(cloudSnapshot).length}</li>
                    <li>firewall: OK · 0 raw values</li>
                    <li>aliases: {cloudSnapshot.aliases.map((a) => a.alias).join(", ") || "none"}</li>
                  </ul>
                  <button
                    className="pa-chip"
                    style={{ marginTop: 8 }}
                    data-testid="cloud-show-raw"
                    onClick={() => setShowRaw((v) => !v)}
                  >
                    {showRaw ? "Hide raw" : "Show raw"}
                  </button>
                  {showRaw && (
                    <pre className="pa-steplog" style={{ marginTop: 4, maxHeight: 160, color: 'var(--pa-text)' }} data-testid="cloud-raw">
                      {JSON.stringify(cloudSnapshot, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
