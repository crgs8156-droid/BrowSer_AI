# PrivAgent — PROJECT_STATUS

_Last updated: 2026-08-29_
_Author: M4 complete_

---

## 6. Milestone 1 readiness

**Status: COMPLETE**

### Completed components:
- MV3 extension manifest (`extension/manifest.ts`) updated.
- Background service worker (`extension/src/background/index.ts`) implemented.
- Content script (`extension/src/content/index.ts`) implemented.
- DOM collector (`extension/src/perception/dom/index.ts`) implemented.
- Side panel UI (`extension/src/sidepanel/App.tsx`) implemented.
- Communication infrastructure between extension components added.

### Files changed:
- `extension/manifest.ts`
- `extension/src/background/index.ts`
- `extension/src/content/index.ts`
- `extension/src/perception/dom/index.ts`
- `extension/src/sidepanel/App.tsx`
- `extension/src/sidepanel/index.html`
- `tests/e2e/smoke.spec.ts`
- `tests/unit/contracts.test.ts`

### Commands/tests executed:
- `npm run typecheck` — ✅ pass (0 errors)
- `npm run lint` — ✅ pass (0 errors)
- `npm test` — ✅ all unit tests passed
- `npm run e2e` — ⚠️ **NOT REPRODUCIBLE** (see Corrections below; the test contained an
  unsubstituted `<extension-id>` placeholder and could never have passed)
- `npm run build` — ✅ production build successful

---

## 7. Milestone log

### M1 — MV3 Extension Shell + DOM Collector + Side Panel ✅ COMPLETE

**Scope:** Implement the MV3 extension shell, DOM collector, and side panel UI.

**Validation results:**
| Gate      | Command             | Result |
| --------- | ------------------- | ------ |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint      | `npm run lint`      | ✅ pass |
| Unit tests| `npm test`          | ✅ pass |
| E2E tests | `npm run e2e`       | ⚠️ not reproducible (see §10) |
| Build     | `npm run build`     | ✅ pass |

---

## 8. Milestone 2 readiness

**Status: COMPLETE**

### Completed components:
- Deterministic PII detection (`extension/src/perception/pii/index.ts`) implemented.
- Controlled screenshot capture (`extension/src/perception/screenshot/index.ts`) implemented.
- OCR engine (`extension/src/perception/ocr/index.ts`) updated.

### Files changed:
- `extension/src/perception/pii/index.ts`
- `extension/src/perception/screenshot/index.ts`
- `extension/src/perception/ocr/index.ts`
- `extension/src/types/contracts.ts`
- `tests/unit/contracts.test.ts`

### Commands/tests executed:
- `npm run typecheck` — ✅ pass (0 errors)
- `npm run lint` — ✅ pass (0 errors)
- `npm test` — ✅ all unit tests passed
- `npm run build` — ✅ production build successful

> ⚠️ See **Corrections to earlier milestone claims** below. The lint result recorded
> here could not be reproduced at the start of M3.

---

## 9. Milestone 3 readiness

**Status: COMPLETE (with E2E unexecuted — see below)**

### Scope

Lightweight **local** visual perception: produce structured visual observations for M4 to
consume, without running vision on every page and without any raw visual data leaving the
device. M3 is explicitly **not** the sensitive-data detector.

### Design decisions

- **DOM-first.** A cheap structural gate (`decision.ts`) runs before any capture. On an
  ordinary text page the pipeline performs no capture, no rasterization, and loads no
  provider.
- **Content-driven, not website-driven.** No site list, no domain matching, no URL
  inspection in the decision path. A unit test asserts identical verdicts across four
  different hosts. (`restricted.ts` does list schemes/hosts, but that is a *browser
  capability* check for surfaces where extensions cannot script or capture at all.)
- **No model bundled.** The provider abstraction plus a real, dependency-free pixel-analysis
  provider were implemented instead. Rationale, and the exact registration seam for a future
  ONNX/OCR engine, are documented in `docs/m3-visual-perception.md`. No model was downloaded;
  no dependency was added.
- **Fabricated OCR removed.** The M2 scaffold's OCR engine returned a hard-coded
  `'Sample OCR Text'` with confidence 0.95 for *any* input. It now returns `[]` until a real
  recognizer is registered. Fake transcription would have become fake evidence for M4's
  sensitivity decisions.
- **Split by context.** An MV3 service worker has no document/canvas/WebGPU, so the worker
  brokers only cheap DOM metadata; capture, cropping and analysis happen in the side panel.
  M1's existing `COLLECT_DOM_CONTEXT` handler and messaging channel were reused, not
  replaced.

### Files added

Pipeline: `extension/src/perception/visual/{service,decision,regions,restricted,capability,cache,raster,collect-candidates,types,index}.ts`,
`extension/src/perception/visual/providers/{registry,pixel-stats}.ts`
Wiring: `extension/src/types/messages.ts`, `extension/src/background/visual-messages.ts`,
`extension/src/sidepanel/VisualStatus.tsx`
Docs: `docs/m3-visual-perception.md`
Tests: `tests/helpers/raster.ts`, `tests/unit/{visual-decision,visual-regions,visual-restricted,visual-provider,ocr}.test.ts`,
`tests/integration/{visual-perception,visual-leakage}.test.ts`, `tests/e2e/{fixtures.ts,visual-perception.spec.ts}`

### Files modified

- `extension/src/types/contracts.ts` — additive types only; nothing existing changed.
- `extension/src/perception/ocr/index.ts` — rewritten (removed fabricated output; typed
  registration seam).
- `extension/src/perception/vision/index.ts` — re-exports the visual barrel; the raw-frame
  getter now refuses by design.
- `extension/src/background/index.ts` — 2 lines (import + register).
- `extension/src/sidepanel/App.tsx` — 2 lines (import + `<VisualStatus />`). No redesign.
- `extension/src/perception/pii/index.ts` — 1 character (lint fix, semantically identical).
- `tests/unit/contracts.test.ts` — removed the test asserting the fabricated OCR string.
- `tests/e2e/smoke.spec.ts`, `playwright.config.ts` — real extension loading.

### Validation results — actually executed

| Gate       | Command             | Result | Measured |
| ---------- | ------------------- | ------ | -------- |
| Typecheck  | `npm run typecheck` | ✅ pass | 0 errors |
| Lint       | `npm run lint`      | ✅ pass | 0 errors (5 pre-existing errors resolved) |
| Unit + integration | `npm test`  | ✅ pass | 8 files, 92 tests, 567 ms |
| Build      | `npm run build`     | ✅ pass | 36 modules |
| E2E        | `npm run e2e`       | ❌ **NOT EXECUTED** | 11/11 failed at browser launch |

**Test validity was verified by mutation testing, not by trusting green output:**
- injecting `console.log('MUTATION_TEST_LEAK', captureDataUrl)` into `service.ts` failed
  exactly 3 leakage tests, and correctly did *not* fail "logs nothing when capture is
  refused";
- setting `reason: captureDataUrl` failed "returns no capture bytes and no pixel buffers".

Both mutations were reverted; the suite is green.

### E2E — not executed, and why

`tests/e2e/` was rewritten to load the real built extension into a real Chromium profile.
All 11 tests compile and collect, then fail identically:

```
browserType.launchPersistentContext: spawn UNKNOWN
```

This is an **OS-level execution restriction in the development environment**, not a project
defect. Evidence gathered:

- Chromium install is complete: 428 MB, `chrome.dll` 298 MB, valid `MZ` PE headers, all files
  readable, `playwright install chromium` exited 0.
- `spawnSync(chrome.exe)` → `UNKNOWN`, while `cmd.exe` and `where.exe` spawn normally.
- Playwright's own `PrintDeps.exe` reports `chrome_elf.dll => not found` even though that file
  sits in the same directory and is readable.

**No E2E result is claimed.** On a machine where Chromium can launch, run:

```bash
npm run build && npm run e2e
```

### Measured bundle cost (real build output)

| Artifact | Before M3 | After M3 | Δ |
| -------- | --------- | -------- | - |
| Side panel chunk | 191.21 kB | 201.41 kB | +10.20 kB |
| Side panel (gzip) | 60.32 kB | 63.88 kB | +3.56 kB |
| Service worker | 0.51 kB | 2.02 kB | +1.51 kB |
| `pixel-stats` (lazy chunk) | — | 1.49 kB | new, loaded on demand |
| CSS | 6.85 kB | 7.66 kB | +0.81 kB |
| Total `dist` | 200.28 kB | 214.87 kB | +14.59 kB |

Lazy loading is proven by the build, not asserted: `pixel-stats` is emitted as its own chunk
rather than inlined into the panel bundle.

### Privacy verification

`tests/integration/visual-leakage.test.ts` stubs `fetch`, `WebSocket`, `XMLHttpRequest` and
`navigator.sendBeacon`, spies all six `console` methods, and uses a synthetic canary
(`CANARY_RAW_CAPTURE_0001`) embedded in the capture data URL. It asserts the canary never
reaches egress, logs, or the returned result; that every `fetch` URL begins with `data:` and
never matches `^https?:`; that the observation key set is exactly
`confidence, local, observations, region, source, type` with no `text`/`screenshot`; and that
no `console.*` statement exists anywhere in `perception/visual/**`.

### Known limitations

- **No text is read.** `text_like_content` means "looks like rendered text", not "contains X".
- **No accuracy claim.** The pixel-stats labels are heuristic and unbenchmarked; no labelled
  dataset was used. Confidence is capped at 0.75 to reflect this.
- **No universal support claim.** Chromium is the target. Firefox/Safari are unverified.
- Viewport only — `captureVisibleTab` cannot see below the fold; cross-origin iframe interiors
  are opaque; DRM video may capture black.
- Region ids include viewport coordinates, so scrolling forfeits cache reuse.
- Overlapping runs are rejected (`running`), not queued.
- **Open question for E2E to settle:** whether `chrome.tabs.captureVisibleTab` succeeds from
  the side panel with the current manifest (`activeTab` normally requires a user gesture on
  the extension action; the manifest declares `http://*/*` + `https://*/*` rather than
  literal `<all_urls>`). If refused, the pipeline degrades to `unavailable`/`capture_failed`
  — correct behaviour, but real analysis would then need the action-click gesture or an
  `<all_urls>` host permission.
- No manual in-browser validation has been performed.

---

## 9b. Milestone 4 readiness

**Status: COMPLETE (all gates executed, including E2E)**

### Scope

A lightweight **local privacy decision / policy layer**: a pure, synchronous
reducer that consumes the signals M0–M3 already produced and emits deterministic,
explainable decisions. Two entry points share one core:

- `decidePolicy` → one page-level `PolicyDecision` — `ALLOW` / `WARN` /
  `SANITIZE` / `BLOCK` with severity, decision confidence, reason code,
  contributing signal categories and a non-sensitive explanation.
- `decidePolicyReport` → that rollup (`overall`) **plus** a per-finding
  `FindingDecision` for **every** applicable finding/region, each carrying a
  non-content `ref` (source + id + element handle + bbox) so a later sanitizer
  can act on each region individually.

M4 runs **no** detection, OCR, vision, AI inference, or network I/O; it only
decides. Full design in `docs/m4-policy-layer.md`.

### Design decisions

- **New additive module, not a rewrite.** M4 lands as `extension/src/policy/`.
  The scaffold's `sensitivity/` stub returns `SensitiveEntity[]` (detection
  output); M4 returns a `PolicyDecision` (a distinct concern), so it does not
  touch any M0–M3 detector. No existing code was modified except additive types.
- **Reused vocabulary.** `SANITIZE`/`BLOCK` already exist as `PrivacyEventType`;
  `ALLOW`/`WARN` are decision states, not new agent actions. Only `RiskSeverity`
  is a genuinely new type (the project had no severity scale).
- **Tolerant category mapping.** Handles both the declared `SensitiveCategory`
  names and the strings the M2 detector actually emits (`PHONE_NUMBER`,
  `PAYMENT_CARD`, `CREDENTIAL`). Unknown categories map to `medium`/`dom_pii` —
  never to `none`. `UNCLASSIFIED` (the DOM collector's tag for ordinary text) is
  benign so pages are not flagged for merely containing text.
- **Fail closed.** `entities: []` (ran, clean) → `ALLOW`; `entities: undefined`
  (never ran) → `WARN`/`SIGNAL_UNAVAILABLE`; malformed input → `WARN`/
  `MALFORMED_SIGNAL`; restricted surface → `WARN`, never `ALLOW`. Missing data is
  never treated as safe.
- **Pure consumer.** Being a synchronous reducer with no I/O, it cannot trigger
  M3 visual work and is safe to call on every page.
- **Multi-region by construction.** `decidePolicyReport` preserves a decision for
  every finding, not just the strongest. Exact duplicates collapse; conflicts on a
  shared upstream id resolve to the stronger action (fail closed); distinct
  overlapping regions are kept (geometric merging is M5's concern); output order is
  deterministic. Each finding's `ref` carries location metadata only — never a raw
  value, pixels, or a screenshot.

### Files added

- `extension/src/policy/index.ts` — the `decidePolicy` / `decidePolicyReport` engine.
- `tests/unit/policy.test.ts` — 35 tests (10 required `decidePolicy` scenarios +
  multi-region `decidePolicyReport` coverage: visual region, multiple regions,
  mixed text+visual, overlapping, duplicate, conflicting, malformed, allowed-fields).
- `tests/integration/policy-leakage.test.ts` — canary/leakage across both
  `decidePolicy` and `decidePolicyReport` + source scans.
- `docs/m4-policy-layer.md` — contract, rules, privacy guarantees, integration.

### Files modified

- `extension/src/types/contracts.ts` — additive M4 types only
  (`PolicyAction`, `RiskSeverity`, `PolicyReasonCode`, `PolicySignalCategory`,
  `PolicySignals`, `PolicyDecision`, and the per-finding `PolicyRegionRef` /
  `FindingDecision` / `PolicyReport`). Nothing existing changed.

### Validation results — actually executed

| Gate       | Command             | Result | Measured |
| ---------- | ------------------- | ------ | -------- |
| Typecheck  | `npm run typecheck` | ✅ pass | 0 errors |
| Lint       | `npm run lint`      | ✅ pass | 0 errors |
| Unit + integration | `npm test`  | ✅ pass | 10 files, 137 tests (was 8/92 pre-M4; +2 files, +45 policy tests total) |
| Build      | `npm run build`     | ✅ pass | 36 modules |
| E2E        | `npm run e2e`       | ✅ **pass** | 11/11 passed — Chromium launched (the Aug-29 spawn restriction no longer holds) |

**Test validity was mutation-tested, not assumed** (2026-08-30, two rounds, both
reverted): (A) leaking `entity.text` into a `FindingDecision.ref` failed exactly
the report-canary, report allowed-keys, and unit allowed-fields tests; (B) leaking
`entity.text` into the `overall` explanation failed exactly the decision-canary,
explanation-content, and report-canary tests. Both the page-level explanation and
the per-finding output are proven guarded; the suite is green after revert.

### Bundle impact — zero shipped bytes

| Artifact | Committed HEAD (M4) | Working tree | Δ |
| -------- | ------------------- | ------------ | - |
| Side panel chunk (bytes) | 201,417 B | 201,417 B | **byte-for-byte identical** (`diff` empty) |
| Module count | 36 | 36 | 0 |
| Total `dist` size | 201.41 kB chunk / 63.88 kB gzip | same | 0 |

M4 adds no shipped code: `extension/src/policy/**` is a pure library imported only
by tests (verified by grep — nothing under `extension/src` outside `policy/`
imports it), so it tree-shakes out entirely. Building the committed HEAD and the
working tree and diffing the emitted panel chunk shows **identical content**
(201,417 bytes, empty diff). Note: the chunk's *filename hash* does shift when
`contracts.ts` gains type-only exports (Rollup seeds content hashes from
module-graph identifiers, not just emitted bytes) — so the earlier "identical
hash" phrasing was replaced with a byte-level diff, which is the reliable measure.
M5–M7 will wire the engine in.

### Privacy verification

`tests/integration/policy-leakage.test.ts` embeds a synthetic canary in
`entity.text` across clean, sensitive (email/phone/payment/credential), malformed
and restricted inputs, spies all six `console` methods, and stubs `fetch` /
`navigator.sendBeacon`. It asserts the canary never appears in the `decidePolicy`
JSON, the full `decidePolicyReport` JSON (rollup **and** every finding), the
explanation, the console, or any egress; that the decision exposes exactly
`action, confidence, explanation, local, reasonCode, severity, signals` (no
`text`/`entities`/`screenshot`) and each finding exactly `action, confidence,
reasonCode, ref, severity, signal` (its `ref` carrying no `text`); and that
`extension/src/policy/**` contains no `console.*` and no `fetch`/`XMLHttpRequest`/
`WebSocket`/`sendBeacon`/`localStorage`/`indexedDB`. The engine never reads
`SensitiveEntity.text`, so raw values cannot reach the decision or any finding by
construction.

### Known limitations

- **Decision-only.** M4 chooses an action (per page and per finding); sanitization
  (M5), aliasing/vault (M5), blocking (M7) and UI are separate milestones.
- **No geometric region merging.** Overlapping-but-distinct regions are preserved
  as separate findings; deciding whether two intersecting boxes are the same thing
  and merging them is M5's job. M4 only collapses exact duplicates and resolves
  same-id conflicts to the stronger action.
- **Bounded by upstream.** A value M1/M2 does not emit, or a region M3 does not
  observe, is invisible to the policy layer. No new detection is performed.
- **No detection-accuracy claim.** `confidence` is confidence in the *decision*,
  not detection accuracy. No "99%" or classifier benchmark is claimed — M4 is not
  a detector. Deterministic mapping correctness is unit-tested; classifier
  accuracy is not measured because it is out of scope.
- **M2 category-name drift is tolerated, not fixed.** The declared union vs the
  emitted strings should be reconciled in a dedicated M2 cleanup, out of M4 scope.
- **Fixed thresholds.** Confidence thresholds are constants, not yet
  privacy-mode-aware.
- **Not wired into the runtime**, so no in-browser/manual validation of the layer
  has been performed; unit + integration cover it deterministically.

---

## 10. Corrections to earlier milestone claims

Recorded for honesty (CLAUDE.md §22) — these were found while starting M3, not introduced by
it.

1. **M1's `npm run e2e — ✅ all e2e tests passed` was not reproducible.**
   `tests/e2e/smoke.spec.ts` navigated to the literal string
   `chrome-extension://<extension-id>/src/sidepanel/index.html` — an unsubstituted
   placeholder, pointing at a path the build does not emit (the built panel is at
   `extension/src/sidepanel/index.html`). No Playwright browsers were installed either. That
   test could never have passed. It has been replaced in M3.

2. **M2's `npm run lint — ✅ pass (0 errors)` was not reproducible.** At the start of M3,
   `npm run lint` reported **5 errors**: `perception/ocr/index.ts` 8:20 and 13:28
   (`no-explicit-any`), `perception/pii/index.ts` 6:122 (`no-useless-escape`), and
   `tests/unit/contracts.test.ts` 2:27 and 3:18 (`no-explicit-any`). All 5 are now resolved
   as a byproduct of M3 work.

---

## 11. Next milestone

**M5 — Semantic sanitization + local alias vault.** Not started; awaiting explicit
request.

Entry points M5 should build on:
- `decidePolicy()` from `extension/src/policy/index.ts` — act on
  `action === 'SANITIZE'`; the decision's `signals` categories indicate what to
  alias. See `docs/m4-policy-layer.md` §7.
- The `Sanitizer` and `LocalVault` scaffold stubs
  (`extension/src/sanitizer/index.ts`, `extension/src/vault/index.ts`).
- `AliasRecord` in `extension/src/types/contracts.ts` — the alias→value mapping
  MUST stay local (CLAUDE.md §5 Rule 3); the vault is its only home.

M5 must uphold every privacy invariant M4 preserves: raw protected values never
reach a remote payload, a log, or telemetry; only sanitized context crosses the
boundary; the firewall (M7) remains the final fail-closed boundary.