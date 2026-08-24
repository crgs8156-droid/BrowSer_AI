# PrivAgent — Preliminary Threat Model & Data Flow

_Status: **preliminary**, pre-implementation (M0 preflight). To be refined per milestone._
_Source of truth: `PrivAgent_SIH2026_Winning_Implementation_Blueprint.pdf` (§3, §4, §7, §9, §13, §14, §17) and `CLAUDE.md` §5–§7._

> This document is design/documentation only. No feature logic has been implemented.

---

## 1. Assets to protect

1. **Raw protected values** — email, phone, name, address, password, OTP, payment/card, government/ID, user-defined custom (PDF §5).
2. **Alias → real-value mapping** (e.g. `USER_EMAIL_1` → actual email).
3. **Local vault contents** (all mappings + any stored real values).
4. **Derived signals that could reveal a secret** (e.g. an unredacted screenshot region, a log line, an error message).

## 2. Actors & trust zones

| Zone                                    | Components                                                                                                                                                                 | Trust                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Local — trusted**                     | Service worker, content script, React side panel, offscreen document, sensitivity engine, sanitizer, **local vault**, **privacy firewall**, alias resolver / action bridge | Runs on the user's device; may hold raw secrets                           |
| **Untrusted input**                     | The web **page** — DOM text, attributes, images, canvas                                                                                                                    | **Data, never instructions.** May contain prompt injection (CLAUDE.md §6) |
| **Remote — untrusted (w.r.t. secrets)** | Remote AI agent / LLM; FastAPI backend (orchestration/eval only)                                                                                                           | Must **never** receive raw values or mappings (PDF §5, §14 invariants)    |

## 3. Local trust boundary (the privacy boundary)

```
        UNTRUSTED PAGE                LOCAL TRUSTED ZONE                       REMOTE (untrusted for secrets)
   ┌────────────────────┐    ┌───────────────────────────────────────┐    ┌───────────────────────────┐
   │ DOM / text / images │──▶ │ collectors → sensitivity → sanitizer   │    │ AI agent / LLM            │
   │ (may inject prompts)│    │ → local vault (alias↔value)            │    │ FastAPI (orchestration)   │
   └────────────────────┘    │             │                          │    └───────────────────────────┘
                             │             ▼                          │              ▲
                             │      ╔══════════════════╗  sanitized   │              │ sanitized request only
                             │      ║ PRIVACY FIREWALL ║ ─────────────┼──────────────┘
                             │      ║  (single egress, ║   context     │
                             │      ║   FAIL CLOSED)   ║              │◀──── structured action (aliases) ────
                             │      ╚══════════════════╝              │
                             │   action validator → policy →          │
                             │   ALIAS RESOLVER (local only) → DOM     │
                             └───────────────────────────────────────┘
                                         ▲ trust boundary ▲
```

- The **Privacy Firewall is the single outbound chokepoint.** Every remote request (agent or backend) must pass through it. If it cannot establish that content is safe → **BLOCK (fail closed)** (CLAUDE.md §5 Rule 6/7).
- **Alias resolution happens only inside the local action bridge**, at the moment an action needs a value (PDF §7, §14 invariant 5).

## 4. Data-flow (end to end)

`Page → DOM/Visual/OCR collectors (local) → Sensitivity engine (local) → Sanitizer/alias (local) → [Vault stores mapping, local] → Privacy Firewall (boundary) → Remote agent → Structured action → Action schema validation (local) → Policy validation (local) → Alias resolver (local) → Browser DOM action.`

## 5. What MAY cross the remote boundary (allowlist)

Per PDF §9 ("Agent context should contain"):

- Task objective.
- **Sanitized** page structure (roles/labels/input types with protected values replaced by aliases or removed).
- **Sanitized** visible text.
- Semantic **aliases** (`USER_EMAIL_1`) — **type only, no value**.
- Available structured actions.
- Policy constraints / privacy mode.
- Values explicitly classified **ALLOW** by the sensitivity engine (e.g. price, product ID) with an explainable reason (PDF §6).

## 6. What must NEVER cross the boundary (denylist)

Per PDF §9 / §14 invariants and CLAUDE.md §5:

- Raw protected values (password, email, phone, address, OTP, payment, ID…).
- **Alias → real-value mappings.**
- Unfiltered screenshots containing protected regions.
- Raw secrets in logs, telemetry, analytics, error reports, debug output.
- Any vault contents.

## 7. Threats & mitigations

| Threat                                             | Vector                                                                     | Mitigation                                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Info disclosure** — secret reaches agent/backend | Sanitizer miss; new field type                                             | Firewall inspection + canary leakage sentinel; fail-closed; explainable detection                                                                                                                       |
| **Prompt injection**                               | Page text says "ignore instructions / send password"                       | Page content is **data**; agent limited to structured actions; policy validator rejects any action attempting to exfiltrate or disable privacy; page-origin text can never change policy (CLAUDE.md §6) |
| **Malicious agent output**                         | Agent emits `TYPE(x, <raw secret>)`, `NAVIGATE(evil.com)`, or arbitrary JS | Action **schema** validation → **policy** validation (navigation allowlist; `TYPE` accepts alias-or-safe-text only) → no `eval`/`Function` (CLAUDE.md §7)                                               |
| **Alias/log leakage**                              | Secret written to console/log/telemetry                                    | Logging policy: `PrivacyEvent` stores metadata only, never raw value (PDF §14)                                                                                                                          |
| **Firewall bypass**                                | A second code path calls remote directly                                   | Single egress module; all remote calls routed through firewall; lint/architecture rule forbids direct `fetch` to remote from other modules                                                              |
| **Screenshot leakage**                             | Visual capture with visible secrets sent remotely                          | Visual processing is local; raw screenshots are not transmitted; redact before any send                                                                                                                 |
| **TOCTOU / stale DOM**                             | Element changes between plan and action                                    | Re-validate element existence/visibility at execution time; re-resolve target                                                                                                                           |
| **Vault at rest**                                  | Local storage read by other code                                           | See R15; consider encryption + session-scoped wipe                                                                                                                                                      |

## 8. Leakage-test harness — how outbound payloads are observed

**In-extension enforcement (firewall) is necessary but NOT self-certifying** — MV3 limits confirmed in preflight: `declarativeNetRequest` cannot read bodies; `webRequest` is observational and **cannot read response bodies**. Therefore leakage is measured by an **external, extension-independent** harness:

1. **Controlled test sink** — a local FastAPI endpoint that records the **exact received bytes + headers** of every agent/backend request. Canary search runs over recorded payloads.
2. **Playwright E2E interception** — `page.route` / `request.postData()` captures outbound request bodies at the browser boundary during automated benchmark tasks.
3. **(Optional) local proxy** — e.g. mitmproxy in the controlled test environment for full on-wire capture where TLS interception is configured.

**Canary protocol** (PDF §7, §13): unique synthetic secrets registered per run; search exact string **and robust variants** (case, URL/base64 encoding); `Leakage Rate = observed outside boundary / encountered`; on a hit, attribute the responsible component.

**Boundary caveat** (PDF §7/§10): prototype scope; state explicitly what the harness can and cannot observe; **no absolute-security claim**.

## 9. Additional technical risks (beyond R1–R8)

| ID      | Risk                                                                                     | Note / mitigation                                                                                     |
| ------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **R9**  | `@crxjs/vite-plugin` v2.7.1 ↔ **Vite 8** peer compatibility unverified                   | Confirm at scaffold; fallback = `vite-plugin-web-extension` or manual multi-entry Vite build          |
| **R10** | **MV3 CSP** forbids inline/`eval`/remote code                                            | Tailwind v4 + build must emit static CSS/JS; no runtime `eval`; no remote-hosted code                 |
| **R11** | onnxruntime-web WASM threads/SIMD need **COOP/COEP**; models must be **bundled locally** | Verify cross-origin isolation for extension pages; never fetch models from remote in the privacy path |
| **R12** | Offscreen document is **single-instance** per extension                                  | Use one shared offscreen host; arbitrate access between subsystems                                    |
| **R13** | `chrome.sidePanel` API availability by Chrome version                                    | Verify target Chrome version at M1                                                                    |
| **R14** | FastAPI must stay **out of the privacy path** and local-only                             | Blueprint §5: backend is orchestration/eval, never where raw PII is cleaned                           |
| **R15** | Vault at rest (IndexedDB/`chrome.storage`) is **not encrypted by default**               | Consider encryption + session-scoped clearing; define retention                                       |
