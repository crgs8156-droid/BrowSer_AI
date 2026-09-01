# PrivAgent-Bench — benchmark & metrics (M7)

Grounded in blueprint §10 (SIH-Grade Benchmark & Metrics), §7 (leakage sentinel) and
§11 (experimental comparison). Every number below is MEASURED by `npm run bench`
(no fabrication — CLAUDE.md §22); the runner writes timestamped artifacts under
`benchmark/reports/` (gitignored).

## How to run

```bash
npm run bench        # PrivAgent-Bench suites → benchmark/reports/latest.{json,md}
npm test             # unit/integration (incl. telemetry + leakage canaries)
npm run build && npm run e2e   # task-success rate measured in the REAL extension
```

CI runs all three; the bench artifacts are uploaded as workflow artifacts.

## Fixture families (blueprint §10)

| Family | Difficulty | Planted categories |
| --- | --- | --- |
| registration/profile | easy | EMAIL, PHONE, NAME, PAYMENT |
| shopping/checkout | easy | EMAIL, PHONE, PAYMENT, CREDENTIAL |
| travel/booking | medium | EMAIL, PHONE, ADDRESS |
| college/administrative | medium | EMAIL, PHONE |
| customer-support | medium | EMAIL, PHONE, CREDENTIAL |
| settings/account-management | medium | EMAIL, PHONE, CREDENTIAL |
| banking-like (synthetic) | hard | EMAIL, PAYMENT |
| medical-like (synthetic) | hard | EMAIL, PHONE, NAME, CREDENTIAL |

All secrets are synthetic and uniquely identifiable (`BENCH_*` canaries, Invariant 6).
`safe` items (prices ₹, order/product/ledger IDs, dates, ward numbers) are
false-positive controls drawn from blueprint §5's decision examples.

## Metric definitions (blueprint §10)

| Metric | Definition | Source |
| --- | --- | --- |
| PII recall | detected planted values / planted values, per category | `evaluateDetection` |
| False-positive rate | safe controls flagged / safe controls | `evaluateDetection` |
| Leakage rate | canaries observed outside the local boundary / canaries encountered (§7 sentinel: exact + case + URL-encoded variants, over every outbound request and step record) | `runLeakageProbe` |
| Task success rate | fixture tasks completed by the REAL extension in e2e / attempted | `tests/e2e/bench-tasks.spec.ts` |
| Local inference latency | detect + enforce wall time per page (p50/p95/max, 20 iterations) | `measurePipelineLatency` |
| Network bytes | serialized `RemoteAgentRequest` bytes per run | `runLeakageProbe` |
| Protection overhead | §11 comparison: payload bytes + fillable sensitive slots for no-protection vs full-redaction vs PrivAgent | `comparisonRow` |

Resource utilization (rubric #4): the honest proxies measured today are bundle size
(CI), per-stage durations (`AgentRunResult.stageMs`) and relay counts.
`performance.memory` is Chromium-only and unreliable under automation — measured only
when present. CPU/GPU/RAM on target hardware: not yet instrumented (documented gap).

## Visual-context accuracy (rubric #1 — 25%)

Planted values rendered ONLY as canvas pixels (`fillText`, no DOM text) — the DOM layer
contributes nothing, so any detection proves the local vision path. The REAL
Tesseract.js wasm engine (extension-local assets) runs in headless Chromium via the
e2e suite; category-level accuracy (the value-free surface the agent sees) is measured
and written to `benchmark/reports/visual-accuracy.{json,md}`.

| Page | Expected | Detected | Engine |
| --- | --- | --- | --- |
| canvas-contact | EMAIL, PHONE | EMAIL, PHONE | ok |
| canvas-card | PAYMENT | PAYMENT | ok |

**Accuracy: 100% (2/2 pages, category-level)** — this also closes the "live wasm
recognition pending manual Chrome verification" item: the engine verifiably runs.

Engineering note (blueprint §3 lightweight rule): the structural analysis budget
(`MAX_ANALYSIS_EDGE = 192`) shrinks text below OCR-readability, so the service elevates
the analysis raster to `OCR_ANALYSIS_EDGE = 1024` ONLY when a content analyzer is
registered — the default no-engine pipeline is unchanged.

## Measured results (fixtures v1, 2026-09-01, CI sandbox)

| Metric | Value |
| --- | --- |
| PII recall (all 25 planted items, 5 categories) | **100%** |
| False-positive rate (16 safe controls) | **0%** |
| Leakage rate (§7 sentinel, 8 pages × full agent runs) | **0%** |
| Task success rate (real extension, 4 DOM-feasible families) | **100%** |
| Local inference latency (p50, node) | **0.01 ms** per page |
| Fail-closed credential pages | 4/4 transmitted **0 bytes** |

§11 comparison per page: no-protection exposes every planted value (4/4 slots) at ~184 B;
full redaction transmits no values but leaves **0 fillable slots**; PrivAgent preserves
**all slots** at ~160 B — high protection with minimal utility loss, which is the
blueprint's "winning graph" direction (§11: replace the target graph with measured data).

## Multi-signal detection (blueprint §5)

M2's pattern detectors handle EMAIL/PHONE/PAYMENT/CREDENTIAL. NAME and ADDRESS have no
reliable pattern, so the agent loop adds **label-evidence extraction**
(`detectLabeledValues`): strict `Name: …` / `Patient: …` / `Address: …` shapes become
entities (confidence 0.8) and flow through the same M4→M5 aliasing. This closes a real
leak the sentinel FOUND during development: unlabeled-name values rode verbatim in
`sanitizedVisibleText` (leakage 0.25 on one page) until label evidence landed.

**Honest boundary:** free-text values with no introducing label and no reliable pattern
(e.g. a name in the middle of a sentence) remain undetectable. Contextual/NLP
classification is the documented next step (blueprint §5 "context-aware sensitivity vs
simple pattern matching" ablation).

## Known limitations

- Credential-bearing pages are **fail-closed blocked** by the M4 policy (critical
  credential ⇒ page-level BLOCK): the agent never drives them and transmits zero bytes.
  The bench asserts this behaviour instead of treating it as a failure.
- Task success is measured over DOM-feasible families; visual-only (canvas/image)
  pages depend on the OCR engine and are not yet part of the success metric.
- Latency figures are node-side pipeline costs; full in-browser per-stage timing lands
  with the telemetry dashboard (next milestone).
