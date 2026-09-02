# PrivAgent — Architecture

This document describes the **module boundaries** and their implementation status after
M7. Every module below is implemented and tested; see
[PROJECT_STATUS.md](../PROJECT_STATUS.md) for the per-milestone logs (files, gates,
privacy verification) and [docs/threat-model.md](threat-model.md) /
[docs/interface-contracts.md](interface-contracts.md) /
[docs/benchmark.md](benchmark.md) for the security design and measured results.

## Runtime surfaces (Chrome MV3)

| Surface            | Path                        | Role                                                        |
| ------------------ | --------------------------- | ----------------------------------------------------------- |
| Service worker     | `extension/src/background/` | Coordinator; opens side panel; routes/relays messages.      |
| Content script     | `extension/src/content/`    | Reads the (untrusted) page DOM; executes structured actions. |
| Side panel (React) | `extension/src/sidepanel/`  | User-facing UI; runs the local pipeline on-device.           |
| Offscreen document | `extension/src/offscreen/`  | Hosts WASM/DOM inference the SW cannot run (M3/M4).         |

## Core modules (implemented)

```
perception/dom      DOM extraction                 (M1 ✅)
perception/ocr      Tesseract.js, local wasm       (M2/M3 ✅, live Chrome verify via e2e)
perception/visual   capture/regions/bands/analyzer (M3 ✅)
perception/pii      pattern + label-evidence PII   (M2 ✅, multi-signal M7 ✅)
perception/visual   faceBlur (ONNX WASM) + pageClassifier (M7.5 ✅)
policy              ALLOW/WARN/SANITIZE/BLOCK      (M4 ✅)
sanitizer           aliasing + mask directives     (M5 ✅)
vault               local alias<->value store      (M5 ✅)
agent               deterministic + remote planner, loop driver (M6 ✅)
actions             schema/policy validation + bridge (M6 ✅)
firewall            single outbound boundary       (M6 ✅, M7 seam complete)
telemetry           value-free audit log + timings (M7 ✅)
types/contracts     shared data contracts          (M0 ✅, extended M3–M7)
```

## The one rule that shapes everything: single egress

All outbound network traffic to a remote model/backend passes through
**`firewall/`** and nothing else. The firewall is the last checkpoint before the
remote boundary and **fails closed** — if it cannot establish that a payload is
alias-only and free of protected values, it blocks. Raw protected values and
alias→value mappings never leave the device and are never logged (CONTRIBUTING.md §5).

```
page DOM (untrusted)
   -> perception -> sensitivity -> sanitizer --(aliases only)--> firewall --> remote
                                         |
                                      vault (local; real values stay here)
```

The agent loop (`agent/loop.ts`) drives this pipeline per step: observe → detect →
enforce → build `RemoteAgentRequest` → firewall → plan → validate → execute locally
(alias resolution happens only in the action bridge, at execution time).

## Backend

`backend/fastapi/` is the planner service (`POST /v1/plan`, alias `POST /v1/act`) with
a provider seam: the deterministic planner ships today; the Ollama/VLM adapter lands
behind `AGENT_PROVIDER=remote`. It is treated as a remote boundary: it must never
receive raw protected values, and its planner works purely on sanitized field
semantics, filled flags and alias bindings.

## Benchmark

`benchmark/` implements PrivAgent-Bench (blueprint §10/§11/§7): synthetic page/task
families with uniquely-identifiable canaries, the §7 leakage sentinel over real agent
runs, and the §11 three-way comparison. Run with `npm run bench`; metric definitions
and measured numbers live in [benchmark.md](benchmark.md).

## Build layout

- Vite + `@crxjs/vite-plugin` builds the MV3 bundle from `extension/manifest.ts`.
- `tsc --noEmit` typechecks; `vitest` runs unit/integration tests (Node env);
  `npm run bench` runs PrivAgent-Bench; Playwright runs browser e2e.
- CI (`.github/workflows/ci.yml`): node gates, backend pytest, e2e, benchmark artifacts.
