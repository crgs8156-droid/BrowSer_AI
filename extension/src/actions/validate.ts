// M6 — structured action validation (blueprint §7, CLAUDE.md §7).
//
// Pipeline stage 1 (schema) and stage 2 (policy). Pure and synchronous: no DOM, no
// network, no vault. A validator can only REJECT; execution and alias resolution
// happen later in the bridge. Webpage content is untrusted data — validation never
// interprets page instructions, it only enforces structural constraints.

import type { AgentAction, AgentActionKind } from '../types/contracts';
import { ALLOWED_ACTION_KINDS } from './kinds';
import { detectPII } from '../perception/pii';

export interface ValidationResult {
  valid: boolean;
  reason: string;
}

export interface ActionPolicy {
  /** NAVIGATE is denied unless the URL starts with one of these https prefixes. */
  navigationAllowlist: string[];
  /** |SCROLL.amount| is clamped/rejected above this bound. */
  maxScroll: number;
}

/** Default M6 policy: navigation fully denied, bounded scrolling. */
export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  navigationAllowlist: [],
  maxScroll: 10_000,
};

const MAX_SELECTOR_LENGTH = 512;
const MAX_TYPED_VALUE_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const ALIAS_PATTERN = /^USER_[A-Z]+_\d+$/;

function isAgentActionKind(value: unknown): value is AgentActionKind {
  return typeof value === 'string' && (ALLOWED_ACTION_KINDS as readonly string[]).includes(value);
}

function fail(reason: string): ValidationResult {
  return { valid: false, reason };
}

function pass(): ValidationResult {
  return { valid: true, reason: 'OK' };
}

/**
 * Stage 1 — schema validation. Rejects anything that is not exactly one of the five
 * structured action shapes with correctly-typed fields. No interpretation, no execution.
 */
export function validateActionSchema(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) return fail('SCHEMA_NOT_AN_OBJECT');
  const action = raw as Record<string, unknown>;

  if (!isAgentActionKind(action['action'])) return fail('SCHEMA_UNKNOWN_KIND');

  switch (action['action']) {
    case 'CLICK':
      if (typeof action['target'] !== 'string' || action['target'].length === 0) {
        return fail('SCHEMA_TARGET_REQUIRED');
      }
      break;
    case 'TYPE':
    case 'SELECT':
      if (typeof action['target'] !== 'string' || action['target'].length === 0) {
        return fail('SCHEMA_TARGET_REQUIRED');
      }
      if (typeof action['value'] !== 'string' || action['value'].length === 0) {
        return fail('SCHEMA_VALUE_REQUIRED');
      }
      break;
    case 'SCROLL':
      if (typeof action['amount'] !== 'number' || !Number.isFinite(action['amount'])) {
        return fail('SCHEMA_AMOUNT_REQUIRED');
      }
      break;
    case 'NAVIGATE':
      if (typeof action['url'] !== 'string' || action['url'].length === 0) {
        return fail('SCHEMA_URL_REQUIRED');
      }
      break;
  }

  // Fail closed on unexpected extra fields: a (future) remote planner cannot smuggle
  // payload through unspecified keys.
  const allowedKeys: Record<AgentActionKind, string[]> = {
    CLICK: ['action', 'target'],
    TYPE: ['action', 'target', 'value'],
    SELECT: ['action', 'target', 'value'],
    SCROLL: ['action', 'amount'],
    NAVIGATE: ['action', 'url'],
  };
  const expected = new Set(allowedKeys[action['action'] as AgentActionKind]);
  for (const key of Object.keys(action)) {
    if (!expected.has(key)) return fail('SCHEMA_UNEXPECTED_FIELD');
  }

  return pass();
}

/**
 * Stage 2 — policy validation. Enforces the constrained action vocabulary:
 * NAVIGATE only to allowlisted https prefixes; bounded SCROLL; TYPE/SELECT values
 * must be a local alias or demonstrably free of detectable PII (a malicious or
 * hallucinating planner cannot type a raw protected value — CLAUDE.md §5 Rule 1).
 */
export function validateActionPolicy(
  action: AgentAction,
  policy: ActionPolicy,
): ValidationResult {
  switch (action.action) {
    case 'CLICK':
      if (action.target.length > MAX_SELECTOR_LENGTH) return fail('POLICY_TARGET_TOO_LONG');
      return pass();

    case 'TYPE':
    case 'SELECT': {
      if (action.target.length > MAX_SELECTOR_LENGTH) return fail('POLICY_TARGET_TOO_LONG');
      if (action.value.length > MAX_TYPED_VALUE_LENGTH) return fail('POLICY_VALUE_TOO_LONG');
      // A local alias is always acceptable — it resolves to the real value only at
      // execution time, on-device. Anything else must scan clean.
      if (ALIAS_PATTERN.test(action.value)) return pass();
      if (detectPII(action.value).length > 0) return fail('POLICY_VALUE_LOOKS_SENSITIVE');
      return pass();
    }

    case 'SCROLL':
      if (Math.abs(action.amount) > policy.maxScroll) return fail('POLICY_SCROLL_TOO_LARGE');
      return pass();

    case 'NAVIGATE': {
      if (action.url.length > MAX_URL_LENGTH) return fail('POLICY_URL_TOO_LONG');
      let parsed: URL;
      try {
        parsed = new URL(action.url);
      } catch {
        return fail('POLICY_URL_MALFORMED');
      }
      if (parsed.protocol !== 'https:') return fail('POLICY_URL_NOT_HTTPS');
      const allowed = policy.navigationAllowlist.some(
        (prefix) => parsed.origin === prefix || parsed.origin.startsWith(prefix),
      );
      if (!allowed) return fail('POLICY_URL_NOT_ALLOWLISTED');
      return pass();
    }
  }
}
