# PrivAgent — PROJECT_STATUS

_Last updated: 2026-08-25_
_Author: M0 scaffolding pass (tooling + typed stubs only; no feature logic)_

This file is the single source of truth for current project state, per the engineering
rules in `CLAUDE.md` §20. It is updated after every milestone.

---

## 0. Reconnaissance summary

A full audit of the working directory was performed. **Nothing has been implemented yet.**
The project is a greenfield/spec-only state: it contains the product specification (PDF)
and the engineering/security rules (`read.md`), and no source code, build system, tests,
or dependencies.

### Files actually present (verified)

| File                                                     | Role                                                   | Notes                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `PrivAgent_SIH2026_Winning_Implementation_Blueprint.pdf` | Authoritative **product spec** (18 pages)              | The user referred to it as `PrivAgent_SIH.pdf`; the real filename differs. Content matches. |
| `CLAUDE.md`                                              | Authoritative **engineering/security rules**           | Renamed from `read.md` by the user (R1 resolved); now auto-loaded by Claude Code.           |
| `docs/threat-model.md`                                   | Preliminary threat model + data flow + leakage harness | Created in M0 preflight.                                                                    |
| `docs/interface-contracts.md`                            | Alias lifecycle + remote-AI input + action contracts   | Created in M0 preflight.                                                                    |

### Environment (verified)

| Tool               | Version | Status                                      |
| ------------------ | ------- | ------------------------------------------- |
| Node.js            | v26.4.0 | present                                     |
| npm                | 11.17.0 | present                                     |
| pnpm / yarn        | —       | not installed                               |
| Python             | 3.14.3  | present                                     |
| pip                | 25.3    | present                                     |
| git                | —       | **not a repository** (no VCS)               |
| poppler / pdftoppm | —       | not installed (PDF page-render unavailable) |

> Tooling side effect: `pypdf` (6.16.2) was installed into the system Python **only to read
> the spec PDF**. It is a local reading tool, not a project dependency, and is not recorded
> in any manifest.

---

## 1. Blueprint requirements → component inventory

Derived from the PDF (§3 features, §4 architecture, §13 repo layout, §14 roadmap, §17 brief).
Every component below is **MISSING** — none exist yet.

| #   | Component (blueprint)                                           | Layer      | Status     |
| --- | --------------------------------------------------------------- | ---------- | ---------- |
| 1   | Chrome MV3 extension skeleton (`manifest.json`)                 | extension  | ❌ missing |
| 2   | Background service worker                                       | extension  | ❌ missing |
| 3   | Content script                                                  | extension  | ❌ missing |
| 4   | React side panel / privacy dashboard                            | UI         | ❌ missing |
| 5   | DOM / accessibility perception (Page Collector)                 | perception | ❌ missing |
| 6   | Visual capture collector                                        | perception | ❌ missing |
| 7   | OCR (text + bbox + confidence)                                  | perception | ❌ missing |
| 8   | Sensitivity engine (rules + context NLP)                        | privacy    | ❌ missing |
| 9   | Multimodal fusion (DOM + OCR + vision)                          | perception | ❌ missing |
| 10  | Semantic sanitizer (aliases, e.g. `USER_EMAIL_1`)               | privacy    | ❌ missing |
| 11  | Local alias vault (IndexedDB / ext storage)                     | privacy    | ❌ missing |
| 12  | AI agent / gateway (structured-action LLM)                      | agent      | ❌ missing |
| 13  | Structured action validator (schema + policy)                   | agent      | ❌ missing |
| 14  | Local action bridge (alias resolution + inject)                 | agent      | ❌ missing |
| 15  | Privacy firewall (final outbound boundary, fail-closed)         | privacy    | ❌ missing |
| 16  | Prompt-injection defense (untrusted webpage handling)           | privacy    | ❌ missing |
| 17  | Leakage Sentinel (canary-based leakage measurement)             | privacy    | ❌ missing |
| 18  | Benchmark system (PrivAgent-Bench + task runner)                | benchmark  | ❌ missing |
| 19  | ONNX Runtime Web local inference (WebGPU + CPU fallback)        | local AI   | ❌ missing |
| 20  | FastAPI backend (orchestration/eval only — NOT PII cleaning)    | backend    | ❌ missing |
| 21  | Automated tests (unit / integration / e2e / security / leakage) | tests      | ❌ missing |
| 22  | Docs (architecture, threat-model, benchmark, demo-script)       | docs       | ❌ missing |

### Privacy invariants that must hold across all of the above (read.md §5, PDF §13/§17)

1. Raw protected values never reach remote AI model or backend.
2. Alias→real-value mapping stays local, never transmitted/logged.
3. Sanitized context contains no original protected value.
4. Privacy firewall is the final outbound boundary; **fail closed** if safety can't be established.
5. Webpage content is untrusted (prompt-injection resistant).
6. Agent emits only validated structured actions (`CLICK/TYPE/SELECT/SCROLL/NAVIGATE`) — no `eval`/arbitrary JS.
7. All secrets in dev/benchmark are synthetic canaries.

---

## 2. Prescribed technology stack (PDF §4, §17)

Nothing is installed for these yet — this is the _target_ stack, not the current state.

- **Extension:** TypeScript + Manifest V3
- **UI:** React + Tailwind CSS (side panel/dashboard)
- **Build:** Vite
- **State:** Zustand (or minimal service state)
- **DOM/actions:** content scripts + Chrome scripting APIs
- **Visual:** Chrome tab/screen capture APIs
- **OCR:** browser-compatible OCR (blueprint says "PaddleOCR or browser-compatible OCR" — PaddleOCR is Python; a browser-runnable engine must be selected/verified)
- **Local inference:** ONNX Runtime Web, WebGPU → CPU fallback
- **NLP:** rules + optional small transformer
- **Local storage:** IndexedDB / extension storage
- **Backend:** Python + FastAPI (orchestration/eval only)
- **Agent:** LLM + constrained structured tools (provider not yet chosen)
- **Testing:** Playwright + unit/integration

---

## 3. Dependencies required (NOT yet installed — for planning only)

To be added milestone-by-milestone after per-package verification (read.md §17). Do **not** bulk-install.

- **Extension core:** `typescript`, `vite`, a MV3 build integration (e.g. `@crxjs/vite-plugin` — _must verify current MV3 support before adopting_), `@types/chrome`
- **UI:** `react`, `react-dom`, `tailwindcss`, `zustand`
- **Local AI:** `onnxruntime-web`; a browser OCR engine (_candidate to verify_, e.g. `tesseract.js` or an ONNX OCR model)
- **Testing:** `@playwright/test`, a unit runner (`vitest` fits Vite)
- **Backend (Python):** `fastapi`, `uvicorn`, `pydantic` (_verify Python 3.14 wheel availability — see Risk R6_)

Every entry above is a candidate pending verification of compatibility and actual need.

---

## 4. Major risks

| ID  | Risk                                                 | Impact                                                                                                                             | Suggested mitigation                                                                           |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1  | Engineering rules live in `read.md`, not `CLAUDE.md` | Claude Code does **not** auto-load `read.md` as project memory; rules may be silently missed in future sessions                    | Copy/rename to `CLAUDE.md` (decision needed)                                                   |
| R2  | Not a git repository                                 | No version control / no regression safety net; conflicts with read.md §16 workflow ("fix smallest safe portion", regression tests) | `git init` before writing code (decision needed)                                               |
| R3  | Working-dir path contains a space: `Browser ai`      | Some build/tool/ONNX/model paths and npm scripts break on unquoted spaces                                                          | Confirm tooling handles it, or relocate project                                                |
| R4  | Heavy in-browser ML (ONNX + WebGPU + OCR) under MV3  | Service workers have no DOM, limited lifetime; WebGPU not guaranteed; model size/latency/memory limits                             | Prototype perception early; enforce CPU fallback; measure (don't claim)                        |
| R5  | Leakage measurement needs to see outgoing payloads   | MV3 `declarativeNetRequest` cannot read request bodies; can't fully self-measure network leakage from inside the extension         | Use external controlled proxy/test harness (blueprint §7 acknowledges this)                    |
| R6  | Node 26 + Python 3.14 are bleeding-edge              | Some deps (onnxruntime, OCR, ML, even FastAPI stack) may lack matching wheels/builds                                               | Verify each dependency's support before install; consider pinned toolchain versions            |
| R7  | Browser-compatible OCR unspecified                   | PaddleOCR is Python-only; naming it risks "inventing" a browser capability (read.md §3)                                            | Select & verify a genuinely browser-runnable OCR before Milestone 3                            |
| R8  | LLM provider/model undefined                         | Agent gateway + firewall design depends on it; must not invent model capabilities (read.md §3)                                     | Defer; decide before Milestone 6 (agent). Latest Claude models are a reasonable default target |

---

## 4a. Preflight risk dispositions (2026-08-25)

Verified in preflight. Details in `docs/threat-model.md` and `docs/interface-contracts.md`.

| Risk | Status                      | Note                                                                                                                                                                      |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | **RESOLVED**                | `read.md` renamed to `CLAUDE.md` by user; now auto-loaded                                                                                                                 |
| R2   | **BLOCKED** (M0 decision)   | Still not a git repo; `git init` recommended before writing code                                                                                                          |
| R3   | **ACCEPTED**                | Node/npm verified handling the spaced path; mitigate by quoting. Relocation optional                                                                                      |
| R4   | **ACCEPTED**                | Feasible: onnxruntime-web `wasm`/`webgpu`/`webgl` verified; run inference in side panel/offscreen (not the worker); code explicit WebGPU→WASM fallback (no auto-fallback) |
| R5   | **ACCEPTED**                | DNR can't read bodies; webRequest can't read response bodies → external harness (FastAPI sink + Playwright `postData`)                                                    |
| R6   | **RESOLVED**                | Node 26 satisfies all JS tool engines; onnxruntime 1.29 ships cp314 wheels. Residual → R9                                                                                 |
| R7   | **ACCEPTED** (decide at M3) | tesseract.js 7 (Apache-2.0, WASM) verified as a browser-runnable OCR candidate                                                                                            |
| R8   | **ACCEPTED** (decide at M6) | Provider-agnostic contract defined; first agent = deterministic JSON planner (no provider)                                                                                |

New risks identified this pass: **R9–R15** — see `docs/threat-model.md` §9.

---

## 5. Proposed build order

Follows the blueprint roadmap (PDF §14 / §17), with a scaffolding milestone added first.

- **M0 — Scaffolding & tooling** (not in blueprint; prerequisite): resolve R1/R2/R3, init git, choose package manager (npm is present), create the `privagent/` repo layout from PDF §13, set up TS + Vite + React + Tailwind + Vitest + Playwright configs, empty module folders with interfaces (PDF §14 data contracts). No feature logic.
- **M1 — MV3 extension + DOM collector + side panel** (roadmap wk1): extension loads, reads a test page, renders structured elements in the side panel.
- **M2 — Rule-based PII detector** (wk2)
- **M3 — Screenshot + OCR** (wk3)
- **M4 — ONNX/WebGPU local inference + fusion** (wk4)
- **M5 — Semantic aliases + local vault** (wk5)
- **M6 — Agent + structured action bridge** (wk6)
- **M7 — Privacy firewall + leakage sentinel** (wk7)
- **M8 — Benchmark + dashboard + demo hardening** (wk8)

Per read.md §24: milestones are started only on explicit user request, one at a time.

---

## 6. Milestone 1 readiness

**Status: READY to start — awaiting explicit authorization (per `CLAUDE.md` §24).**

M1 (per roadmap) = MV3 extension skeleton + DOM collector + side panel. Prerequisites:

- ✅ Node/npm present and modern.
- ✅ Product spec and engineering rules read and understood.
- ✅ M0 scaffolding complete: build system, configs, typed module stubs, tests, backend health, git repo (see §7).
- ✅ Decisions resolved: git initialized (R2); `npm` (R3 path kept, tooling verified with the space); `@crxjs/vite-plugin` verified building on Vite 8 (R9) — manual multi-entry fallback not needed.
- ⛔ Not started: M1 begins only on explicit user request.

**What M1 will build on:** the `extension/src/perception/dom` stub (`DomCollector`), the side panel React shell, and the content script — all currently scaffolds that throw / no-op.

---

## 7. Milestone log

### M0 — Scaffolding & tooling ✅ COMPLETE (2026-08-25)

**Scope:** scaffolding only. No PII detection, OCR, ML, sanitization, vault, LLM, agent, or
firewall feature logic. Every core module is a typed stub whose methods throw
`"... not implemented (M#)."` until its milestone lands. No LLM provider chosen.

**Delivered**

- **Repo + VCS:** `git init` (branch `main`); `.gitignore` (ignores `node_modules/`, `dist/`,
  `venv/` at any depth, `coverage/`, test artifacts, `.env*`, model weights, benchmark
  outputs). Spec PDF is intentionally tracked; `CLAUDE.md` is intentionally _not_ prettier-formatted.
- **Toolchain (npm):** TypeScript 5.9.3 (pinned for typescript-eslint compat), Vite 8, React 19,
  Tailwind v4, Zustand 5, Vitest 4, Playwright 1.62, ESLint 9 (flat), Prettier 3.
- **MV3 extension** (`extension/`): `manifest.ts` (least-privilege: `sidePanel`/`storage`/`offscreen`,
  content script scoped to `localhost` only), background service worker, content script,
  React side panel (+ Tailwind), offscreen document.
- **Typed module boundaries** (`extension/src/`): `perception/{dom,ocr,vision}`, `sensitivity`,
  `sanitizer`, `vault`, `agent`, `actions` (+ `kinds.ts` allowlist), `firewall`, `telemetry`,
  `types/contracts.ts` (shared data contracts).
- **Backend** (`backend/fastapi/`): FastAPI app with `GET /health`; `requirements.txt`; pytest.
- **Tests:** Vitest unit (`tests/unit/contracts.test.ts`) + Playwright e2e (`tests/e2e/smoke.spec.ts`).
- **Docs:** `docs/architecture.md`, `README.md` (threat-model + interface-contracts from preflight).

**Validation results (all green)**

| Gate                | Command             | Result                                            |
| ------------------- | ------------------- | ------------------------------------------------- |
| Typecheck           | `npm run typecheck` | ✅ pass (0 errors)                                |
| Lint                | `npm run lint`      | ✅ pass (0 errors)                                |
| Unit tests          | `npm test`          | ✅ 2 passed                                       |
| Extension build     | `npm run build`     | ✅ built; `@crxjs` on Vite 8 (no fallback needed) |
| Backend health test | `pytest`            | ✅ 1 passed                                       |
| E2E setup           | `npm run e2e`       | ✅ 1 passed (Chromium)                            |
| Format              | `prettier --check`  | ✅ clean                                          |

**Errors fixed during M0**

1. `vite.config.ts` used `esbuild: { jsx: 'automatic' }`, invalid on Vite 8 (Rolldown/oxc, no
   esbuild). Fixed → `oxc: { jsx: { runtime: 'automatic' } }`. Verified against the installed
   Vite 8 type defs.
2. Unit test asserted an async rejection, but the stub throws synchronously. Fixed the test to
   assert a synchronous throw (matches actual guard behavior).
3. Extensionless config import warning → added `allowImportingTsExtensions` + explicit `.ts`.
4. **`.gitignore` bug:** pattern `backend/venv/` did not match the real venv path
   `backend/fastapi/venv/` — the venv risked being tracked. Fixed → `venv/` (any depth);
   confirmed ignored via `git check-ignore`.

**Non-blocking notes**

- Starlette 1.6.0 emits a forward-looking `httpx2` deprecation warning under `TestClient`; test passes.
- ONNX/OCR deps deliberately deferred (not needed to scaffold; avoids large installs before M3/M4).

**Git checkpoint:** committed on `main` (hash reported to the user in the M0 completion report).
