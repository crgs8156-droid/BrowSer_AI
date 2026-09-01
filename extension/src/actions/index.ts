// M6 — local action bridge (blueprint §7/§9, CONTRIBUTING.md §7).
//
// The FULL validation pipeline every agent action must pass before it touches the page:
//
//   1. schema validation      (actions/validate.ts — pure)
//   2. policy validation      (actions/validate.ts — pure)
//   3. LOCAL alias resolution (vault — the mapping never leaves the device)
//   4. execution              (content script — constrained DOM operation only)
//
// No arbitrary JavaScript is ever executed; the content script performs only the five
// constrained operations. A failed stage stops the pipeline and is reported with a
// structured code — never retried blindly, never silently dropped.

import type { AgentAction } from '../types/contracts';
import type { LocalVault } from '../vault';
import type { ExecuteActionResponse } from '../types/messages';
import {
  DEFAULT_ACTION_POLICY,
  validateActionPolicy,
  validateActionSchema,
  type ActionPolicy,
} from './validate';

export type { ValidationResult } from './validate';
export { ALLOWED_ACTION_KINDS } from './kinds';

const ALIAS_PATTERN = /^USER_[A-Z]+_\d+$/;

export interface ActionBridge {
  /**
   * Run the full pipeline and execute. Resolves with a structured outcome — `ok`
   * plus a code (OK, NOT_FOUND, …, or the failing validation stage's reason code).
   * Never throws for a rejected action; throws only if the messaging channel itself fails.
   */
  execute(action: AgentAction): Promise<ExecuteActionResponse>;
}

export interface ActionBridgeOptions {
  /** Static policy, or a provider resolved per execution (session allowlists change). */
  policy?: ActionPolicy | (() => ActionPolicy);
  /** Local alias↔value store. TYPE/SELECT values that are aliases resolve here. */
  vault: LocalVault;
  /** Transport to the page executor. Injectable for tests. */
  sendToPage?: (action: AgentAction) => Promise<ExecuteActionResponse>;
  /** Fired after a successful LOCAL alias resolution — metadata only, never the value. */
  onAliasResolved?: (alias: string) => void;
}

async function executeViaContentScript(action: AgentAction): Promise<ExecuteActionResponse> {
  const response: ExecuteActionResponse | undefined = await chrome.runtime.sendMessage({
    type: 'EXECUTE_ACTION',
    action,
  });
  return response ?? { ok: false, code: 'EXEC_FAILED' };
}

export function createActionBridge(options: ActionBridgeOptions): ActionBridge {
  const resolvePolicy = (): ActionPolicy =>
    typeof options.policy === 'function' ? options.policy() : (options.policy ?? DEFAULT_ACTION_POLICY);
  const sendToPage = options.sendToPage ?? executeViaContentScript;
  const { vault } = options;

  return {
    async execute(action: AgentAction): Promise<ExecuteActionResponse> {
      const schema = validateActionSchema(action);
      if (!schema.valid) return { ok: false, code: schema.reason };

      const policyVerdict = validateActionPolicy(action, resolvePolicy());
      if (!policyVerdict.valid) return { ok: false, code: policyVerdict.reason };

      // Stage 3 — resolve a TYPE/SELECT alias to the real value, ON-DEVICE, as late as
      // possible. Unknown/expired aliases fail closed and are never typed.
      let effective = action;
      if (
        (action.action === 'TYPE' || action.action === 'SELECT') &&
        ALIAS_PATTERN.test(action.value)
      ) {
        const resolved = await vault.resolve(action.value);
        if (resolved === undefined) return { ok: false, code: 'ALIAS_UNKNOWN' };
        options.onAliasResolved?.(action.value);
        effective =
          action.action === 'TYPE'
            ? { action: 'TYPE', target: action.target, value: resolved }
            : { action: 'SELECT', target: action.target, value: resolved };
      }

      return sendToPage(effective);
    },
  };
}
