// M6 — deterministic JSON action planner (blueprint §8).
//
// The FIRST AgentGateway implementation, recommended by the blueprint to make the
// demo reproducible and debuggable before any LLM provider is chosen. It is a PURE
// function of the sanitized request: no network, no DOM, no state.
//
// Design: the loop re-plans after every executed action, and the sanitized structure
// reports whether each field is filled — so the planner needs NO memory. The page
// state after step N is the only input for step N+1. That also makes it
// injection-resistant by construction: page labels are matched only against a fixed
// structural keyword table, never interpreted as instructions (CONTRIBUTING.md §6).

import type { AgentAction, RemoteAgentRequest, SensitiveCategory, SanitizedNode } from '../types/contracts';
import type { AgentGateway } from './index';

/** Category → field-name/label keywords the planner may match against. */
const CATEGORY_FIELD_KEYWORDS: Readonly<Record<SensitiveCategory, readonly string[]>> = {
  EMAIL: ['email'],
  PHONE: ['phone', 'tel', 'mobile'],
  NAME: ['name', 'fullname', 'first-name', 'last-name'],
  ADDRESS: ['address', 'street', 'city'],
  PASSWORD: ['password', 'passwd'],
  OTP: ['otp', 'code', 'pin'],
  PAYMENT: ['card', 'cc'],
  ID: ['id'],
  CUSTOM: [],
};

/** One viewport-height scroll step toward a below-fold control (blueprint §8 SCROLL). */
const SCROLL_STEP = 720;

/** Button labels treated as submit/advance controls. */
const SUBMIT_LABELS = /^(submit|send|continue|next|sign in|log in|login|register|book|pay|done)(\b|\s|$)/i;

/** Task verbs that justify clicking a submit-style control. */
const SUBMIT_TASK_VERBS =
  /\b(submit|send|continue|next|sign in|log in|login|register|book|pay|complete|finish)\b/i;

function isField(node: SanitizedNode): boolean {
  return node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select';
}

function matchesCategory(node: SanitizedNode, keywords: readonly string[]): boolean {
  const haystack = `${node.inputType ?? ''} ${node.name ?? ''} ${node.label ?? ''}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

/**
 * Deterministic planner. Returns AT MOST ONE action per call — the loop re-plans after
 * executing it, so progress comes from the re-observed page state, not from planning
 * several steps ahead against stale data. An empty result means "nothing left to do".
 */
export function planDeterministic(request: RemoteAgentRequest): AgentAction[] {
  const nodes = request.sanitizedPageStructure;

  // 1 — fill the first empty, enabled field matched to an available alias. A field
  // below the current fold gets one bounded SCROLL first; after the scroll the loop
  // re-observes (belowFold is recomputed viewport-relative), so no scroll bookkeeping.
  for (const binding of request.aliases) {
    const keywords = CATEGORY_FIELD_KEYWORDS[binding.category] ?? [];
    if (keywords.length === 0) continue;
    const field = nodes.find(
      (node) =>
        isField(node) &&
        !node.filled &&
        !node.disabled &&
        matchesCategory(node, keywords),
    );
    if (field) {
      if (field.belowFold === true) return [{ action: 'SCROLL', amount: SCROLL_STEP }];
      return [{ action: 'TYPE', target: field.selector, value: binding.alias }];
    }
  }

  // 2 — all alias-matched fields are filled: advance, but only if the TASK asks for it.
  if (SUBMIT_TASK_VERBS.test(request.taskObjective)) {
    const submit = nodes.find(
      (node) => node.tag === 'button' && !node.disabled && node.label !== undefined && SUBMIT_LABELS.test(node.label),
    );
    if (submit) {
      if (submit.belowFold === true) return [{ action: 'SCROLL', amount: SCROLL_STEP }];
      return [{ action: 'CLICK', target: submit.selector }];
    }
  }

  // 3 — explicit navigation: when the task names a site, the planner may emit exactly
  // one NAVIGATE — and only to an origin the LOCAL policy allowlists. The planner never
  // invents a URL: the target origin must come from the allowlist itself, and the loop
  // skips the action when the browser is already there (pageOrigin, origin-only).
  const match = /\b(?:open|go to|navigate to|visit)\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(
    request.taskObjective,
  );
  if (match && request.pageOrigin !== undefined) {
    const host = match[1]?.toLowerCase() ?? '';
    const target = request.policy.navigationAllowlist.find((entry) => {
      try {
        const hostname = new URL(entry).hostname;
        return hostname === host || hostname.endsWith(`.${host}`);
      } catch {
        return false;
      }
    });
    if (target !== undefined) {
      try {
        if (new URL(request.pageOrigin).hostname !== new URL(target).hostname) {
          return [{ action: 'NAVIGATE', url: target }];
        }
      } catch {
        // malformed pageOrigin: never navigate on unknown context (fail closed)
      }
    }
  }

  return [];
}

export function createDeterministicPlanner(): AgentGateway {
  return {
    async plan(request: RemoteAgentRequest): Promise<AgentAction[]> {
      return planDeterministic(request);
    },
  };
}
