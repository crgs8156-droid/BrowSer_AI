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
// structural keyword table, never interpreted as instructions (CLAUDE.md §6).

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

  // 1 — fill the first empty, enabled field matched to an available alias.
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
      return [{ action: 'TYPE', target: field.selector, value: binding.alias }];
    }
  }

  // 2 — all alias-matched fields are filled: advance, but only if the TASK asks for it.
  if (SUBMIT_TASK_VERBS.test(request.taskObjective)) {
    const submit = nodes.find(
      (node) => node.tag === 'button' && !node.disabled && node.label !== undefined && SUBMIT_LABELS.test(node.label),
    );
    if (submit) {
      return [{ action: 'CLICK', target: submit.selector }];
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
