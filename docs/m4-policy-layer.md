# M4 — Local Privacy Decision / Policy Layer

Status: implemented. Last updated 2026-08-29.

This document records what the M4 policy layer does, the contract it exposes, the
deterministic rules it applies, and the privacy guarantees it holds. It builds on
M0–M3 and is consumed by M5–M7.

---

## 1. What M4 is for

M4 answers one question: **given what M0–M3 already observed about the current
context, how should the extension treat it?** The answer is a single
`PolicyDecision` — one of `ALLOW`, `WARN`, `SANITIZE`, or `BLOCK`, with a
severity, a decision confidence, an explainable reason code, the contributing
signal categories, and a non-sensitive explanation.

M4 is **not** a detector. It runs no OCR, no vision model, no AI inference, and
no network call. It does not re-scan the page. It only reduces signals that
already exist:

- `SensitiveEntity[]` — PII/DOM hits from M1/M2 (`perception/pii`, `perception/dom`)
- `VisualPerceptionResult` — structural visual observations from M3
- a `restricted` flag — the browser-restricted-surface signal from M3

Because it is a pure consumer, it **cannot** cause M3 visual work to run, and it
adds nothing to any shipped code path until a later milestone imports it.

---

## 2. The contract

Types live in `extension/src/types/contracts.ts` (added additively; nothing
existing was changed). The engine is `extension/src/policy/index.ts`:

```ts
export function decidePolicy(signals: PolicySignals): PolicyDecision;
```

```ts
interface PolicySignals {
  entities?: SensitiveEntity[];      // undefined ⇒ detection did not run
  visual?: VisualPerceptionResult;   // undefined ⇒ visual perception did not run
  restricted?: boolean;              // true ⇒ browser-restricted surface
}

interface PolicyDecision {
  action: 'ALLOW' | 'WARN' | 'SANITIZE' | 'BLOCK';
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  confidence: number;                // 0..1 — confidence in the DECISION
  reasonCode: PolicyReasonCode;
  signals: PolicySignalCategory[];   // deduped, sorted; categories only
  explanation: string;               // categories + counts, never a raw value
  local: true;
}
```

`ALLOW` / `WARN` are **decision states**, not new agent actions. `SANITIZE` and
`BLOCK` reuse the vocabulary already present in `PrivacyEventType`. No new
user-facing action was invented — M5's sanitizer and M7's firewall are the
components that will act on `SANITIZE` / `BLOCK`.

`RiskSeverity` is the one genuinely new type; the project had no severity scale
before M4.

---

## 3. Deterministic rules

The engine turns each signal into zero or more **contributions**, then selects
the one with the highest action precedence (`BLOCK > SANITIZE > WARN > ALLOW`),
breaking ties by higher severity, then higher confidence. Same input → same
output; the result is independent of entity order.

### 3.1 Category → severity

Tolerant of both the declared `SensitiveCategory` names and the strings the M2
detector actually emits. Unknown strings are conservative, never safe.

| Category (incl. M2 variants) | Severity | Signal tag |
|------------------------------|----------|------------|
| `PASSWORD`, `CREDENTIAL`, `OTP` | critical | `credential` |
| `PAYMENT`, `PAYMENT_CARD` | high | `payment` |
| `ID` | high | `identity` |
| `ADDRESS`, `PHONE`, `PHONE_NUMBER`, `EMAIL` | medium | `contact` |
| `NAME`, `CUSTOM` | low | `personal` |
| `UNCLASSIFIED` (DOM default for ordinary text) | none (benign) | — |
| anything else | **medium** (conservative) | `dom_pii` |

`UNCLASSIFIED` is explicitly benign: the DOM collector tags *every* visible text
node with it, so treating it as a hit would flag every page. Only classified PII
elevates the decision.

### 3.2 Severity + confidence → action

Confidence bands: **confirmed** ≥ `0.85`, otherwise **possible** (a weak hit is
never discarded).

| Severity | confirmed | possible |
|----------|-----------|----------|
| critical | **BLOCK** (`CRITICAL_CREDENTIAL`) | **SANITIZE** (`POSSIBLE_SENSITIVE_DATA`) |
| high / medium | **SANITIZE** (`CONFIRMED_SENSITIVE_DATA`) | **WARN** (`POSSIBLE_SENSITIVE_DATA`) |
| low | **WARN** | **WARN** |
| none | **ALLOW** (`NO_SENSITIVE_DATA`) | — |

### 3.3 Visual and restricted signals

- A **completed** M3 result carrying a `text_like_content` observation at
  confidence ≥ `0.6` contributes **WARN / `VISUAL_UNCERTAINTY`** — "there is
  rendered text here we could not read", never a sensitivity verdict (M3 reads
  no text). `not_required` / `unavailable` / `running` contribute **nothing**, so
  an ordinary DOM-first page is never dragged to `WARN` by the visual layer.
- `restricted === true` (or M3 status `restricted_page`) contributes
  **WARN / `RESTRICTED_CONTEXT`** and **prevents `ALLOW`**. A surface we cannot
  fully inspect is never declared safe.

### 3.4 The none / possible / confirmed distinction

- **none** — a signal ran and classified nothing sensitive.
- **possible** — a hit below the confirmed threshold, or visual uncertainty.
- **confirmed** — a hit at/above `0.85`.

This maps to the required three-way sensitivity distinction and is surfaced in
both `severity` and `reasonCode`.

---

## 4. Fail-safe behaviour

Absence of evidence is never treated as evidence of safety (CLAUDE.md §5 Rule 7).

| Situation | Decision |
|-----------|----------|
| `entities: []` (ran, nothing found), no other concern | `ALLOW` / `NO_SENSITIVE_DATA` |
| `entities` **undefined** and no visual/restricted signal | `WARN` / `SIGNAL_UNAVAILABLE` |
| whole input `null`/not an object | `WARN` / `MALFORMED_SIGNAL` |
| an entity in the array is malformed | contributes `WARN` / `MALFORMED_SIGNAL` |
| a malformed entity alongside a real critical hit | real hit still wins (malformed only raises the floor) |
| restricted surface | `WARN` / `RESTRICTED_CONTEXT`, never `ALLOW` |

The `undefined` vs `[]` distinction is the crux: "detection did not run" and
"detection ran and found nothing" are different states with different safe
answers, and both are unit-tested.

---

## 5. Privacy guarantees

| Invariant | How it is enforced |
|-----------|--------------------|
| No raw value in the decision | The engine never reads `SensitiveEntity.text`; the explanation is built from category tags and counts only |
| No raw value in logs | Zero `console.*` in `extension/src/policy/**`, asserted by a source scan |
| No pixels/screenshots in policy state | The engine holds no reference to rasters, captures, or screenshot ids; it reads only M3's derived labels |
| Minimum metadata retained | The decision keeps only action, severity, confidence, reason, signal *categories*, and a non-sensitive explanation |
| No external network call | No `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`/storage anywhere in `policy/**`, asserted by a source scan; the function is pure |
| Deterministic | No clock, no randomness; identical input yields identical output |

`tests/integration/policy-leakage.test.ts` embeds a synthetic canary
(`CANARY_SECRET_…`) in `entity.text` across clean, sensitive, malformed and
restricted inputs and asserts it never appears in the decision JSON, the
explanation, the console, or any egress channel. These assertions were
**mutation-tested**: injecting the canary into the explanation caused exactly the
two canary assertions to fail; the mutation was reverted.

---

## 6. What M4 does NOT claim

- **No detection-accuracy figure.** `confidence` is confidence in the *decision*
  given the signals, not a claim that detection is correct. Detection accuracy is
  bounded by M1/M2 (deterministic regex) and M3 (heuristic, capped at 0.75). No
  "99% detection" or similar is claimed anywhere.
- **No new detection.** If M1/M2 miss a value, M4 cannot see it — it only decides
  over what it is handed.
- **Not wired into the runtime yet.** M4 is a library. It is exercised by tests
  but not imported by the background worker, content script, or side panel, so it
  adds **0 bytes** to the shipped bundle. M5–M7 will consume it.

---

## 7. Integration points (for M5–M7)

- **M5 (sanitizer + vault):** act on `action === 'SANITIZE'`. The `signals`
  categories indicate what to alias; the vault resolves aliases locally.
- **M7 (privacy firewall):** treat `action === 'BLOCK'` (and, fail-closed, any
  decision the firewall cannot reconcile) as an outbound block. `WARN` surfaces to
  the user; `ALLOW` still passes through the firewall — the firewall, not M4, is
  the final boundary (CLAUDE.md §5 Rule 6).
- **Telemetry (M7):** `PolicyDecision` is already log-safe (categories/counts
  only), but telemetry must still avoid attaching any raw context around it.

---

## 8. Known limitations

- **Decision-only.** M4 chooses an action; it does not perform sanitization,
  aliasing, blocking, or UI. Those are later milestones.
- **Bounded by upstream.** A category the M1/M2 detector does not emit, or a
  region M3 does not observe, is invisible to the policy layer.
- **Category drift is tolerated, not fixed.** The M2 detector emits
  `PHONE_NUMBER` / `PAYMENT_CARD` / `CREDENTIAL`, which differ from the declared
  `SensitiveCategory` union (hidden by casts in M2 code). M4 maps both forms and
  treats unknowns conservatively, but the underlying naming mismatch in M2 is out
  of M4 scope and should be reconciled in a dedicated cleanup.
- **Fixed thresholds.** Confidence thresholds are constants, not user-tunable or
  policy-mode-aware yet. A future privacy-mode setting could scale them.
- **Not benchmarked as a classifier.** The rules are deterministic and unit-
  tested for correctness of *mapping*, but no labelled dataset accuracy is
  claimed, because M4 is not a detector.
