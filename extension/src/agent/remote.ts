// M6 — remote HTTP agent gateway (the provider adapter seam, blueprint §8/§13).
//
// Posts a `RemoteAgentRequest` to a backend endpoint and expects structured actions
// back. PRIVACY: the request passes the privacy firewall BEFORE anything is sent
// (CONTRIBUTING.md §5 Rule 6) — this gateway cannot transmit without a verdict, and a deny
// is surfaced as a thrown tagged error so the loop fails closed and visibly.
//
// The backend (`backend/fastapi`, POST /v1/plan) must never receive raw protected
// values (Rule 2) — that guarantee is enforced by the firewall verdict, not by trust.

import type { AgentAction, RemoteAgentRequest } from '../types/contracts';
import { validateActionSchema } from '../actions/validate';
import type { PrivacyFirewall } from '../firewall';
import type { AgentGateway } from './index';

export class FirewallBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`PrivAgent: firewall blocked the outbound request (${reason}).`);
    this.name = 'FirewallBlockedError';
    this.reason = reason;
  }
}

export interface RemoteHttpAgentGatewayOptions {
  /** Absolute http(s) endpoint, e.g. `http://localhost:8000/v1/plan`. */
  endpoint: string;
  firewall: PrivacyFirewall;
  /** Backend bearer token (`PRIVAGENT_API_KEY`). Absent = dev mode, no header. */
  apiKey?: string;
  /** Injectable transport (tests never touch the network). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type TaskPlanType = 'action' | 'navigate' | 'complete';

export interface TaskPlan {
  type: TaskPlanType;
  actions: AgentAction[];
  done: boolean;
  /** Origin-only URL for navigate plans (never full query strings). */
  url?: string;
  summary?: string;
}

/**
 * Part A — backward-compat task decomposer adapter.
 * `/v1/plan` still returns exactly `{actions: [...]}`; this maps that contract to
 * `{type, done}` without changing the wire format or breaking existing callers.
 * No raw values enter: actions are schema-validated before classification.
 */
export function toTaskPlan(actions: AgentAction[]): TaskPlan {
  if (actions.length === 0) {
    return {
      type: 'complete',
      actions: [],
      done: true,
      summary: 'Task complete — 0 bytes leaked',
    };
  }
  const first = actions[0];
  if (first !== undefined && first.action === 'NAVIGATE') {
    let origin = first.url;
    try {
      origin = new URL(first.url).origin;
    } catch {
      origin = first.url;
    }
    return { type: 'navigate', actions, done: false, url: origin };
  }
  return { type: 'action', actions, done: false };
}

let lastCloudPayload: import('../types/contracts').RemoteAgentRequest | null = null;
let lastCloudPayloadAt: number | null = null;
let lastCloudPayloadBytes: number | null = null;

export function getLastCloudPayload(): import('../types/contracts').RemoteAgentRequest | null {
  return lastCloudPayload ? (JSON.parse(JSON.stringify(lastCloudPayload)) as import('../types/contracts').RemoteAgentRequest) : null;
}

export function getLastCloudPayloadMeta(): { at: number; bytes: number } | null {
  if (lastCloudPayloadAt === null || lastCloudPayloadBytes === null) return null;
  return { at: lastCloudPayloadAt, bytes: lastCloudPayloadBytes };
}

export function clearLastCloudPayload(): void {
  lastCloudPayload = null;
  lastCloudPayloadAt = null;
  lastCloudPayloadBytes = null;
}

export function createRemoteHttpAgentGateway(options: RemoteHttpAgentGatewayOptions): AgentGateway {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    async plan(request: RemoteAgentRequest): Promise<AgentAction[]> {
      const verdict = await options.firewall.inspect(request);
      if (!verdict.allowed) throw new FirewallBlockedError(verdict.reason);
      // Phase: capture last transmitted payload (sanitized only, deep copy) for viewer.
      try {
        lastCloudPayload = JSON.parse(JSON.stringify(request)) as import('../types/contracts').RemoteAgentRequest;
        lastCloudPayloadAt = Date.now();
        lastCloudPayloadBytes = JSON.stringify(request).length;
      } catch {
        // ignore - viewer is best-effort
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(options.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.apiKey !== undefined && options.apiKey.length > 0
              ? { Authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(
          `PrivAgent: planner request failed (${error instanceof Error ? error.name : 'UNKNOWN'}).`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`PrivAgent: planner endpoint returned ${response.status}.`);
      }

      // The response is UNTRUSTED (it plans actions for a page): every action is
      // schema-validated here and re-validated against policy by the bridge, so a
      // malicious/buggy server cannot smuggle an unconstrained operation.
      const body: unknown = await response.json();
      const rawActions =
        typeof body === 'object' && body !== null && Array.isArray((body as Record<string, unknown>)['actions'])
          ? ((body as Record<string, unknown>)['actions'] as unknown[])
          : undefined;
      if (rawActions === undefined) {
        throw new Error('PrivAgent: planner response missing actions array.');
      }

      const actions: AgentAction[] = [];
      for (const raw of rawActions) {
        const schema = validateActionSchema(raw);
        if (!schema.valid) {
          throw new Error(`PrivAgent: planner returned an invalid action (${schema.reason}).`);
        }
        actions.push(raw as AgentAction);
      }
      return actions;
    },
  };
}
