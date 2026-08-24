# PrivAgent — Interface Contracts (preliminary)

_Status: **preliminary**, pre-implementation (M0 preflight). Types shown are contract sketches, not committed code._
_Grounded in blueprint §7, §9, §14. No LLM provider is chosen here (deferred with justification — see §2)._

> Design/documentation only. No feature logic implemented.

---

## 1. Alias lifecycle

State machine for every protected value:

```
DETECTED ──▶ ALLOCATED ──▶ IN_USE (remote) ──▶ RESOLVED (local, at action) ──▶ EXPIRED (wiped)
```

| Phase         | Where                      | What happens                                                                                                                                                                                      |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DETECTED**  | local (sensitivity engine) | Value flagged sensitive with category + confidence + reasons                                                                                                                                      |
| **ALLOCATED** | local (sanitizer + vault)  | Assign a stable, typed, opaque alias `USER_<CATEGORY>_<n>`; store `alias ↔ value` in the **local vault**, marked local-only                                                                       |
| **IN_USE**    | crosses boundary           | Only the **alias + category** appears in sanitized context / agent I/O. Mapping never leaves the device                                                                                           |
| **RESOLVED**  | local (action bridge)      | At action execution, **after** schema + policy validation, the alias is resolved to its real value and injected into the target element. Record metadata only (`ALIAS_RESOLVED`), never the value |
| **EXPIRED**   | local (vault)              | On task/session end, tab close, or extension reload → mapping wiped                                                                                                                               |

**Alias invariants** (PDF §7): stable within a session/task · opaque (encodes no part of the secret) · typed (`USER_EMAIL_1` not `VALUE_7`) · unique · non-reversible by the remote agent · resolvable **only** locally · mapping never placed in prompts, logs, telemetry, or benchmark exports.

## 2. Remote AI input contract (provider-agnostic)

The remote agent receives a single **sanitized** request object. The provider (which LLM/API) is **deliberately not chosen yet** — justification: the blueprint (§8) recommends starting with a _deterministic action planner or simple JSON-emitting agent_ to make the demo reproducible and reduce debugging; the privacy boundary is provider-independent; and CLAUDE.md §3 forbids inventing model capabilities. A thin **provider adapter** will map this contract to a concrete API when one is chosen (target ≈ M6).

```ts
// sketch — subject to refinement
type RemoteAgentRequest = {
  taskObjective: string;
  sanitizedPageStructure: SanitizedNode[]; // roles/labels/input types; values aliased or removed
  sanitizedVisibleText: string; // aliased
  aliases: { alias: string; category: string }[]; // TYPE ONLY — never the value, never the mapping
  availableActions: AgentActionKind[]; // CLICK | TYPE | SELECT | SCROLL | NAVIGATE
  policy: { privacyMode: string; navigationAllowlist: string[] };
};
```

**Firewall gate:** every `RemoteAgentRequest` passes the privacy firewall before transmission. Denied content (raw values, mappings, unfiltered screenshots) → block/replace, fail closed.

## 3. Structured agent action contract

From blueprint §14 — the agent emits **only** these structured actions (no arbitrary JS):

```ts
type AgentAction =
  | { action: 'CLICK'; target: string }
  | { action: 'TYPE'; target: string; value: string } // value = alias or safe text only
  | { action: 'SELECT'; target: string; value: string }
  | { action: 'SCROLL'; amount: number }
  | { action: 'NAVIGATE'; url: string };
```

**Validation pipeline** (PDF §7 action contract, §9 validation column; CLAUDE.md §7):

```
Agent output
  → 1. Schema validation      (well-formed AgentAction)
  → 2. Target verification    (element exists + visible + allowed)
  → 3. Policy validation      (TYPE: alias-or-safe-text only; NAVIGATE: allowlist; SCROLL: bounds)
  → 4. Local alias resolution (only here; only if needed)
  → 5. Execute browser action
  → 6. Record metadata only   (never the resolved secret)
```

Forbidden at every stage: `eval`, `Function`, arbitrary code execution, or any action originating from page-injected instructions.

## 4. Supporting types (from blueprint §14, for reference)

```ts
type SensitiveEntity = {
  id: string;
  category:
    'EMAIL' | 'PHONE' | 'NAME' | 'ADDRESS' | 'PASSWORD' | 'OTP' | 'PAYMENT' | 'ID' | 'CUSTOM';
  source: 'DOM' | 'OCR' | 'VISION' | 'FUSED';
  text?: string; // LOCAL ONLY for protected entities
  bbox?: [number, number, number, number];
  confidence: number;
  reasons: string[];
  elementId?: string;
};

type AliasRecord = {
  alias: string; // e.g. USER_EMAIL_1
  category: string;
  sessionId: string;
  createdAt: number;
  // actualValue MUST remain local (stored in vault, never serialized remotely)
};

type PrivacyEvent = {
  type: 'DETECTED' | 'SANITIZED' | 'BLOCKED' | 'ALIAS_RESOLVED' | 'TASK_RESULT';
  entityCategory?: string;
  alias?: string;
  timestamp: number; // never store the raw protected value
};
```
