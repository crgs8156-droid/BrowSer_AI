# PrivAgent — PROJECT_STATUS

_Last updated: 2026-08-30_
_Author: Real local OCR (Tesseract.js) integrated — visual content pass live_.
_Engineering rules: [CONTRIBUTING.md](CONTRIBUTING.md) (formerly `CLAUDE.md`; section
numbers unchanged)._


---

## 0. Real local OCR integration (post-M5 hardening)

**Status: COMPLETE (code + all offline gates green); live wasm recognition
pending manual Chrome verification.**

### What was implemented
- **Real local OCR engine** — `extension/src/perception/ocr/tesseract.ts` wraps
  Tesseract.js v6 with a lazy `createWorker('eng', 1, …)`. All runtime assets are
  loaded from **extension-local URLs** via `chrome.runtime.getURL('ocr/…')`
  (`workerPath`, `corePath`, `langPath`, `gzip:true`, `cacheMethod:'none'`).
  No screenshot or pixel ever leaves the machine — there is no remote OCR call.
- **OCR → PII bridge** — `extension/src/perception/visual/ocr-analyzer.ts`
  recognizes word boxes, reassembles line text with per-word offset spans, runs
  the SAME `detectPII` used for DOM text, and unions the covering word boxes into
  one bbox per finding (confidence = averaged OCR confidence of the covered words).
- **Provenance (requirement D)** — a `source` field flows analyzer →
  `VisualContentFinding` → policy → mask directive → summary, so OCR-recognized
  regions surface as `OCR_REGION_n` and non-text painted regions stay
  `IMAGE_REGION_n`. Nothing is labelled OCR unless OCR actually read text.
- **Production wiring** — `extension/src/perception/register-ocr.ts`
  (`installOcrEngine()`) is called once in `sidepanel/main.tsx`. Tests never import
  it; they inject a FAKE engine (requirement I).
- **MV3 CSP** — `manifest.ts` sets
  `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` so
  the Tesseract wasm loads under MV3.
- **Bundling** — `vite.config.ts` `publicDir: 'extension/public'` ships the OCR
  runtime into `dist/`.

### Honest engine behaviour (CONTRIBUTING.md §22)
- Load failure throws a tagged `OCR_ENGINE_UNAVAILABLE`; the analyzer reports
  `not_available` (no engine) or `failed` (engine threw) — it never fabricates text.
- The wasm engine cannot run under vitest/node, so unit tests verify only the
  deterministic fail-honest path; real recognition is a **manual Chrome** step.

### Multi-region (requirement E) — preserved, not rewritten
The existing M3 pipeline keeps every selected region up to `MAX_REGIONS`; each
region yields its own observation → policy decision → mask directive. Overlap
merging (`mergeMaskRegions`) merges only genuinely overlapping directives;
independent regions stay distinct. Verified by the integration suite (independent
findings preserved; disjoint boxes not merged).

### dist/ inspection (requirement J)
`npm run build` → `dist/ocr/` contains:
- `worker.min.js` (111 KB)
- `core/tesseract-core-lstm.wasm` (2.87 MB) + `.wasm.js` (3.95 MB)
- `core/tesseract-core-simd-lstm.wasm` (2.87 MB) + `.wasm.js` (3.95 MB)
- `lang/eng.traineddata.gz` (1.98 MB)

**Total `dist/` = 16 MB — PASS (<100 MB).** No new heavyweight model, no persisted
bitmap; browser-native `captureVisibleTab` + geometry + lazy/temporary processing.

### Gates (all run this session)
| Gate | Result |
|------|--------|
| `npm run typecheck` | PASS (clean) |
| `npm run lint` | PASS (0 errors; `extension/public/**` vendored assets ignored) |
| `npm run test` | PASS — 260/260 (25 files) |
| `npm run build` | PASS |
| `npm run e2e` | PASS — 12/12 (smoke, scan-findings, visual-perception) |

### Cannot be verified in this sandbox (stated honestly, requirement K)
- Live Tesseract wasm recognition of real pixels (needs a real Chrome + OffscreenCanvas).
- Real `chrome.tabs.captureVisibleTab` capture of an actual tab.
Both are exercised only via injected fakes offline; the production path is wired
and asset-complete but must be confirmed by loading `dist/` in Chrome.

### Capture-broker fix (VISUAL_CAPTURE_UNAVAILABLE in the real browser)
**Symptom:** the panel reported `Reason: VISUAL_CAPTURE_UNAVAILABLE … 0 analysed`
on ordinary pages. **Root cause:** capture ran IN the side-panel document via
`chrome.tabs.captureVisibleTab(WINDOW_ID_CURRENT=-2, …)`; from a panel document `-2`
does not resolve to the window holding the web page, so Chrome refused the capture.
**Fix (no new API, no engine change, capture stays local):**
- New `CAPTURE_VIEWPORT` message brokered by the background worker
  (`extension/src/background/index.ts` `captureActiveViewport`): it resolves the
  active tab's OWN `windowId` (same query SCAN_PAGE uses) and calls
  `captureVisibleTab(windowId, …)`, returning ONLY the PNG data URL (or `restricted`/
  a short error code). The data URL is handed back to the panel for local rasterization
  and never leaves the device.
- Panel bridge `extension/src/sidepanel/capture.ts` (`captureViaBackground`) is injected
  as the service's `captureViewport` dep in both `App.tsx` and `VisualStatus.tsx`.
- The service's `CAPTURE_FAILED` trace now records a short, sanitized Chrome diagnostic
  (`safeCaptureError`, strips `data:`/`base64`, caps 120 chars) so the real cause of a
  refusal is visible while the result reason stays the single code `VISUAL_CAPTURE_UNAVAILABLE`.
- Tests: `tests/integration/scan-message-path.test.ts` gains 5 CAPTURE_VIEWPORT cases
  (uses tab's own windowId not -2; restricted fail-closed; NO_ACTIVE_TAB; forwards
  Chrome error string; EMPTY_CAPTURE). Re-ran all gates: typecheck/lint clean,
  **269/269** unit+integration, build OK, **12/12** e2e.

### Capture ROOT CAUSE: host permission (`<all_urls>`)
Surfacing the sanitized Chrome diagnostic (`reasonDetail`, rendered as `Detail:` in
`VisualStatus.tsx`) revealed the actual cause:
> `Either the '<all_urls>' or 'activeTab' permission is required.`

`chrome.tabs.captureVisibleTab` accepts **only** the literal `<all_urls>` host
permission, or `activeTab` **plus a qualifying user gesture** (an action/menu/command
click). The broad patterns we declared (`http://*/*`, `https://*/*`) are **not** accepted
for this API, and our capture is triggered from a side-panel button — which does not
grant `activeTab`. So capture was refused on every ordinary page, independent of the
windowId fix (which was still necessary and is retained).

**Fix:** `extension/manifest.ts` `host_permissions: ['<all_urls>']` (documented minimum;
verified against Chrome docs, not invented). Scope is unchanged in practice: M3 still
only perceives http/https — `perception/visual/restricted.ts` continues to treat every
other scheme as restricted by design, so `<all_urls>` does not widen what is inspected.
Captured pixels are still rasterized locally and never leave the device.

Gates after the permission fix: typecheck PASS, lint PASS, **271/271** unit+integration,
build PASS (`dist/manifest.json` contains `"host_permissions": ["<all_urls>"]`),
**12/12** e2e. Live capture success still requires a manual Chrome reload to confirm.

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

## 9c. Milestone 5 readiness

**Status: COMPLETE (all gates executed, including E2E)**

### Scope

A lightweight, **local sanitization + privacy-enforcement layer** that consumes
the M4 `PolicyReport` (per-finding decisions) plus the raw `SensitiveEntity[]`
that produced them, and neutralises **every** applicable finding before any
content can be placed on a `RemoteAgentRequest`. Text findings are aliased out of
the visible text; visual findings become mask directives; nothing sensitive is
ever silently dropped. Full design in `docs/m5-sanitization.md`.

### Design decisions

- **Implemented the existing stubs, added one orchestrator.** `Sanitizer`
  (`extension/src/sanitizer/index.ts`) and `LocalVault`
  (`extension/src/vault/index.ts`) were throwing scaffold stubs; M5 implements
  them as declared. The genuinely new surface is `enforcePrivacy`
  (`extension/src/sanitizer/enforce.ts`) — the policy-driven orchestrator that M4
  §7 always described as M5's job — plus additive result types. No M1–M4 code was
  modified except additive types in `contracts.ts`.
- **Findings carry no raw value (by M4 design), so M5 correlates.** A
  `FindingDecision.ref.findingId` equals the upstream `SensitiveEntity.id`; M5
  indexes the entities by id to recover `.text` for redaction. It never reads a
  value out of the finding itself.
- **Aliases only cross the boundary; values stay in the vault.** The alias
  directory is `{ alias, category }[]` (type only). The alias↔value mapping lives
  solely in the in-memory `LocalVault`, session-scoped and wiped by `clearSession`
  (CONTRIBUTING.md §5 Rule 3/4).
- **Visual enforcement is region masking, not outbound image scrubbing.**
  `RemoteAgentRequest` has no image field, so raw pixels never cross the boundary
  by construction (M3 invariant). M5 emits geometry-only mask directives and
  provides a pure local pixel-mask primitive (`applyMasks`) — a local
  defence-in-depth measure, honestly scoped, not an over-claim.
- **Overlap is a deterministic union.** `mergeMaskRegions` merges intersecting
  boxes into their bounding union to a fixpoint, preserving every finding id, so
  the protected area is never smaller than the sum of the sensitive regions.
  Disjoint regions stay separate (the whole page is never masked because two
  far-apart regions are sensitive).
- **Fail closed on the text boundary.** Each finding gets exactly one
  disposition — `aliased` / `masked` / `flagged` (malformed) / `inaccessible`
  (no value and no region). `enforced` is true only when every finding is
  neutralised and the page is not uncertain. Cleartext `sanitizedText` is emitted
  **only** when the page is fully safe (`enforced && !blocked && !restricted`);
  otherwise it is withheld (empty), so an unidentified raw value can never ride
  out on the sanitized text (CONTRIBUTING.md §5 Rule 7).

### Files added

- `extension/src/sanitizer/alias.ts` — category normalisation, stable/unique
  alias allocation, literal (regex-free) redaction.
- `extension/src/sanitizer/mask.ts` — `mergeMaskRegions` (overlap → union) and
  `applyMasks` (pure local pixel masking).
- `extension/src/sanitizer/enforce.ts` — the `enforcePrivacy` orchestrator.
- `tests/unit/vault.test.ts` — 5 tests (store/resolve/clear/fail-closed).
- `tests/unit/sanitizer.test.ts` — primitive tests (alias, redact, category,
  text `Sanitizer`, region merge, pixel mask).
- `tests/unit/enforce.test.ts` — the 16 required M5 scenarios, each labelled.
- `tests/integration/sanitizer-leakage.test.ts` — canary/leakage across every
  branch + source scan (comments stripped) proving no console/network/storage.
- `docs/m5-sanitization.md` — architecture and privacy guarantees.

### Files modified

- `extension/src/sanitizer/index.ts` — implemented `Sanitizer`; barrel-exports
  the M5 primitives and `enforcePrivacy`.
- `extension/src/vault/index.ts` — implemented the in-memory `LocalVault`.
- `extension/src/types/contracts.ts` — additive M5 types (`AliasBinding`,
  `FindingDisposition`, `VisualMaskDirective`, `FindingEnforcement`,
  `EnforcementResult`).

### Validation results

| Gate      | Command             | Result |
| --------- | ------------------- | ------ |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint      | `npm run lint`      | ✅ pass |
| Unit + integration | `npm test` | ✅ **182 passed / 182** (14 files; +45 over M4's 137) |
| Build     | `npm run build`     | ✅ pass (36 modules) |
| E2E tests | `npm run e2e`       | ✅ **11 passed / 11** |

One genuine defect was found and fixed by testing, not by weakening the test: a
malformed-only signal left the raw value in `sanitizedText` because M5 could not
identify it. Fixed by withholding cleartext unless the page is fully safe.

### Known limitations

- **Not wired into the runtime.** M5 is a tested library; the content-script /
  agent-request path that calls `enforcePrivacy` and feeds `visualMasks` into a
  local capture is a later milestone. Bundle sizes are unchanged from M4 because
  the side-panel entry does not import M5 yet.
- **Vault is volatile.** In-memory only; not persisted (persisting a raw value at
  rest would need encryption — threat-model R15). Mappings vanish with the context.
- **Masking is local-only.** It protects a local pixel buffer; because no image
  crosses the boundary, this is defence-in-depth, not the outbound guarantee. The
  outbound guarantee is that raw text/pixels/mappings never appear on the request.
- **Bounded by upstream.** A value M1/M2 does not emit or a region M3 does not
  observe is invisible to M5; no new detection is performed. No detection-accuracy
  claim is made.
- **Restricted/inaccessible content is not claimed as sanitized.** It is reported
  (`restricted` / disposition `inaccessible`) and fails certification — never
  falsely reported as protected.

---

## 9d. Side-panel scan wiring + M3 below-the-fold improvements

**Status: COMPLETE (typecheck, lint, 219 unit/integration tests, build, 12 E2E all pass)**

### SCAN_PAGE communication fix (root cause + fix)

**Symptom:** manual scans returned `PAGE_UNREACHABLE` ("Could not read this page…") and
reloading the page did not help.

**Root cause:** the `SCAN_PAGE` relay reached the page with `chrome.tabs.sendMessage`, which
requires a *declared* content-script receiver. Declared content scripts only auto-inject into
pages loaded **after** the extension; a tab already open (or one whose async content-script
loader had not yet registered its `onMessage` listener) has no receiver, so `sendMessage`
fails with `lastError` → `PAGE_UNREACHABLE`. (The M3 `COLLECT_VISUAL_CANDIDATES` path never had
this problem because it injects on demand via `chrome.scripting.executeScript`.)

**Fix (`extension/src/background/index.ts`):** the relay now mirrors that proven pattern. On a
missing receiver it injects the built content-script file(s) — read at runtime from
`chrome.runtime.getManifest().content_scripts[0].js`, using the existing `scripting` +
http/https `host_permissions` (no new grant) — and retries. `PAGE_UNREACHABLE` is surfaced
**only** when injection itself is refused, i.e. the browser genuinely forbids access (fail
closed, CONTRIBUTING.md §5 Rule 7). The `SCROLL_VIEWPORT` relay uses the same path. Also removed the
stray `action.default_popup` from the manifest so the toolbar icon opens the **side panel**
(it previously suppressed `openPanelOnActionClick`).

**Deterministic test:** `tests/integration/scan-message-path.test.ts` installs a fake `chrome`
and drives the worker's listeners: receiver-present relay; **missing receiver → inject →
retry succeeds** (the fix); injection refused → `PAGE_UNREACHABLE`; restricted URL →
`{restricted:true}` with no injection; no active tab → `NO_ACTIVE_TAB`; unknown type ignored;
plus the two `SCROLL_VIEWPORT` cases.

### Manual verification (supported setup)

The extension declares **http/https** host permissions only; `isRestrictedUrl` treats
`file:`, `chrome:`, etc. as restricted (fail closed). Opening the fixture as **`file://` is
therefore intentionally NOT supported** — it reports "Restricted page", never a scan. Serve it
over http instead:

```bash
npx serve tests/fixtures    # or: python -m http.server 8000 --directory tests/fixtures
```

Then: load `dist/` at `chrome://extensions` (Developer mode → Load unpacked; **Reload** after a
rebuild) → open `http://localhost:3000/sensitive-sample.html` (or the printed URL) → click the
PrivAgent toolbar icon to open the side panel → **Scan Page**. Expect a concise summary
(counts, `USER_*` aliases, `IMAGE_REGION_N`, "outbound blocked") with no raw values/heading.
Note: this Chrome click-through cannot be exercised in the CI sandbox; the E2E suite drives the
identical production path over `https://privagent.test`, and the message-path unit test covers
the injection fallback deterministically.

### Scope

Two connected pieces of work, both **wiring/UI + hardening only** — no change to the
M2/M4/M5 detection, policy, or sanitization logic:

1. **The side panel now consumes a structured, sanitized result — never a raw page dump.**
   Previously the panel collected every DOM element's `textContent` and rendered it. It now
   sends `SCAN_PAGE`, and the whole M2→M5 pipeline runs **on-device in the panel document**:
   `detectPII` (M2) → `visualService.run` (M3) → `enforcePrivacy` (M4+M5). The panel renders
   only the derived `ScanSummary` (counts, semantic aliases, masked-region metadata). This
   also closes M5 §11 integration point (1): the running extension now calls
   `enforcePrivacy()` and honours its `blocked` fail-closed gate in the UI.

2. **M3 multi-region + bounded below-the-fold image coverage.**

### Design decisions

- **All detected regions are preserved.** Each region → one observation → one M4
  `FindingDecision` (dedupe key includes bbox) → one M5 mask directive; only genuinely
  overlapping directives merge (`mergeMaskRegions`). Independent regions surface as distinct
  `IMAGE_REGION_1..N`, bounded by `MAX_REGIONS = 4` (the cap is surfaced honestly, not hidden).
- **Below-the-fold TEXT is fully covered** because `pageText` is whole-document `innerText`
  plus form-field values; M2 sees it all (proven by `USER_EMAIL_2` below the fold in E2E).
- **Below-the-fold IMAGES: bounded band capture, injected — never faked.** `captureVisibleTab`
  only returns the current viewport and Chrome exposes no off-screen capture API. The service
  gained an **optional** `scrollViewport(top)` dependency:
  - **Absent** (all prior tests, any non-scrollable context) → byte-identical single-viewport
    behavior. Below-fold images are simply not covered, and that limit is reported honestly.
  - **Present** (production, injected by the panel via a `SCROLL_VIEWPORT` relay to the content
    script) → the pure `planBelowFoldBands` planner groups whole-document candidates into at
    most `MAX_BELOW_FOLD_BANDS = 3` viewport-height bands that actually contain candidates,
    sharing the `MAX_REGIONS` budget (largest first). The service scrolls to each band,
    captures the now-visible viewport, crops only that band's regions, analyses, and
    **restores the original scroll** in a `finally`. Any band capture/scroll failure degrades
    closed — that band's regions are skipped, never fabricated.
- **Collector reports document-absolute inputs** (`scrollY`, `documentHeight`) and keeps
  below-fold candidates (only content scrolled above the fold or off to the sides is culled).
  Existing viewport-relative fields are unchanged, so raster/regions/E2E stay green.

### Files

- `extension/src/sidepanel/App.tsx` — runs the pipeline on `SCAN_PAGE`; injects a real
  `scrollViewport`; renders the `ScanSummary` only.
- `extension/src/scan/summary.ts`, `extension/src/scan/index.ts` — pure `buildScanSummary`.
- `extension/src/perception/visual/service.ts` — optional `scrollViewport` dep + bounded band
  loop with scroll-restore.
- `extension/src/perception/visual/bands.ts` — pure `planBelowFoldBands` planner.
- `extension/src/perception/visual/collect-candidates.ts` — keeps below-fold candidates; adds
  `scrollY`/`documentHeight`.
- `extension/src/content/index.ts`, `extension/src/background/index.ts`,
  `extension/src/types/messages.ts` — `SCAN_PAGE` + `SCROLL_VIEWPORT` message contracts/relays.

### Tests

- `tests/unit/scan-summary.test.ts`, `tests/integration/scan-summary-leakage.test.ts` —
  multi-region summary, section math, canary-absent-from-summary.
- `tests/unit/visual-bands.test.ts` — planner coordinate math, banding, budget/cap, clipping.
- `tests/integration/visual-belowfold.test.ts` — no-scroller honest limit; band capture with
  scroll-restore; multiple independent below-fold regions; failed-band degrade-closed;
  visible+below-fold together.
- `tests/e2e/smoke.spec.ts`, `tests/e2e/scan-findings.spec.ts` — no raw dump; below-fold text
  alias; critical credential blocks outbound; raw values + page heading absent from the panel.

### Lightweight (<100 MB)

Built `dist/` is **261 KB** (largest asset: the panel bundle at 218 KB / 69.5 KB gzip). No new
AI/OCR/CV model, no new runtime dependency, no persisted screenshot/bitmap — browser-native
`captureVisibleTab` + geometry/DOM metadata + bounded/lazy processing + temporary disposal.
**<100 MB: PASS.**

### Honest limitations

- **No image-content classification.** No OCR/vision model is bundled; image regions are
  surfaced as *masked regions + page section*, never a fabricated category.
- **Band capture cannot recover content already scrolled above the fold** at snapshot time
  (`rect.bottom <= 0` candidates are dropped) and is bounded to 3 extra bands; anything beyond
  is not claimed as covered.
- **A page opened before the extension loaded** has no content script → `PAGE_UNREACHABLE`;
  the panel asks the user to reload (fail-closed, honest).

---

## 9e. Popup fix + OCR/vision content-analysis layer

_Added 2026-08-30._

### Priority 1 — the toolbar icon opened nothing (FIXED)

**Root cause (diagnosed from the built `dist/manifest.json`, not guessed):** the manifest's
`permissions` were `['storage','activeTab','scripting']` — MISSING `"sidePanel"`. Chrome only
defines `chrome.sidePanel.*` when that permission is declared, so the background worker's
`chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })` silently no-opped.
Combined with the earlier (correct) removal of `action.default_popup`, the toolbar action had
neither a popup nor an enabled side-panel behavior → clicking did nothing.

**Fix:** added `'sidePanel'` to `extension/manifest.ts` permissions. One line; no logic change.
The PAGE_UNREACHABLE on-demand-injection fallback (§9d, `background/index.ts`) is untouched and
still passes its 8 deterministic tests.

**Regression guard:** `tests/integration/built-extension.test.ts` (8 assertions) validates the
BUILT `dist/`: MV3 manifest shape, `sidePanel` permission present, `action.default_popup` absent
(so it can't suppress the side panel), the side-panel HTML + background worker + every declared
content-script file exist in `dist/`, and every non-external asset the panel HTML references
resolves. Rebuilt `dist/manifest.json` confirmed to now carry `["storage","activeTab","scripting","sidePanel"]`.

### Priority 2 — genuine OCR/vision content-analysis interface (NO engine bundled)

The visual pipeline now has a provider-agnostic **content analyzer** boundary that recognizes
WHAT sensitive value a captured region contains — distinct from the coarse structural
`VisualProvider`. Reuses M3→M4→M5 unchanged in shape; additive only.

- **Interface** (`perception/visual/types.ts`): `VisualContentAnalyzer.analyze(raster, region,
  backend) → { status:'ok'|'not_available'|'failed', findings: RawVisualContentFinding[] }`.
  Findings carry `category`, `confidence`, raster-space `bbox`, optional `text`.
- **Honest default** (`perception/visual/content-analyzer.ts`): with no engine registered the
  registry returns a constant analyzer that ALWAYS reports `not_available` and zero findings —
  nothing is constructed, nothing is fabricated (CONTRIBUTING.md §22). `registerVisualContentAnalyzer()`
  is the single, lazy integration point for a real local ONNX/OCR engine later.
- **Coordinate mapping** (`perception/visual/coords.ts`, pure): `mapRasterBboxToRegion` inverts
  the rasterizer's crop+downscale so an engine's raster-pixel box maps back to the region's CSS-px
  space (document-absolute for below-fold, viewport-relative for visible), clamped to analyzed pixels.
- **Service wiring** (`perception/visual/service.ts`): after the structural provider, the same
  raster is passed to the content analyzer. `ok` findings are mapped, region-tagged (`regionId`),
  and returned on `VisualPerceptionResult.contentFindings`; `VisualPerceptionResult.contentStatus`
  reports `not_available|ok|failed` honestly. An engine that throws → `failed`, zero findings.
  Findings are cached alongside observations (repeat scans re-emit without re-running the engine).
- **Masking integration** (`policy/index.ts`): each categorized visual finding is classified with
  the SAME category table as DOM/PII, producing a per-finding decision with its bbox. Distinct
  sub-boxes get distinct finding ids (`regionId#bbox`) so MULTIPLE INDEPENDENT findings survive;
  M5 `mergeMaskRegions` keeps disjoint regions separate and merges only true overlaps. A critical
  category (e.g. PASSWORD) in an image escalates to a page-level BLOCK (fail-closed, no cleartext).

### Reality check (honest answers)

- **Is REAL OCR/vision available?** NO. No engine is bundled; the default analyzer returns
  `not_available`. The interface, coordinate mapping, masking, and tests are ready for a real
  local engine to be dropped in via `registerVisualContentAnalyzer()`.
- **Is image-based sensitive-data detection functional end-to-end?** The full path
  (capture → region → analyzer → categorized finding → coord-map → policy → independent mask →
  block) is functional and tested WITH A FAKE ENGINE. In production, with no engine registered,
  it correctly yields zero visual content findings — by design, not by failure.
- **Recognized `text` never leaks:** it stays on the local `VisualPerceptionResult` only; policy
  never reads it and it is absent from `EnforcementResult` and the summary (canary test asserts this).

### Tests added (all green)

- `tests/integration/built-extension.test.ts` — 8 (Priority 1 build/manifest/asset validation).
- `tests/unit/visual-coords.test.ts` — 5 (raster→region bbox conversion, clamping, degenerate).
- `tests/unit/visual-content-analyzer.test.ts` — 4 (not_available default, laziness, single
  in-flight construction, reset).
- `tests/integration/visual-content-findings.test.ts` — 7 (not_available/no fabrication; ok→finding
  with mapped doc coords + regionId; multiple independent findings; engine-throws→failed;
  independent masks through M4→M5; critical→block+no cleartext; OCR-text canary non-leakage).

### Gates (measured 2026-08-30)

- `typecheck` ✅ · `lint` ✅ · `test` ✅ **243 passed** (23 files) · `build` ✅ · `e2e` ✅ **12 passed**.
- **Lightweight:** `dist/` = **261 KB** total (largest asset 216 KB panel bundle). No new
  dependencies, no bundled model/OCR/CV assets. <100 MB requirement: PASS.

### Remaining limitations

- No local OCR/vision engine ships yet (the whole point of the honest `not_available` default).
- Below-fold IMAGE coverage remains bounded band-capture (§9d); below-fold TEXT is fully covered
  via whole-page `innerText`. Unchanged by this work.
- Fully-cached regions with no prior findings leave `contentStatus` unset (first scan reports it).

---

## 9f. Milestone 6 — agent loop, action bridge, firewall seam, backend planner

_Added 2026-09-01. All numbers below were actually measured in this workspace; nothing is
claimed that was not run (CONTRIBUTING.md §22)._

### Scope

The M6 milestone from `docs/architecture.md`: the provider-agnostic **agent**, the
**structured action validator + local action bridge**, and — because a working loop
requires egress — the **privacy firewall** that CONTRIBUTING.md §5 Rule 6 makes the single
outbound boundary. Plus the backend planner endpoint (`POST /v1/plan`) and a CI
workflow (the repository previously had none).

### Design decisions

- **Panel-driven loop, pure modules.** `runAgentLoop` (`extension/src/agent/loop.ts`)
  lives in a DI-only module: observation (SCAN_PAGE relay), enforcement (M4+M5),
  firewall, planner and bridge are all injected, so unit tests run the REAL
  enforcement/firewall/planner against fake pages. The panel (`AgentTask.tsx`) only
  wires real implementations and renders alias-level step records.
- **Stateless planner; the page state is the loop memory.** The deterministic planner
  (`agent/planner.ts`) is a pure function of the sanitized request and returns AT MOST
  ONE action. After execution the loop re-observes: a filled field reports `filled:
  true` in the sanitized structure, so the planner advances without any memory. This
  also makes it prompt-injection-resistant by construction: page labels are matched
  only against a fixed structural keyword table, never interpreted as instructions
  (CONTRIBUTING.md §6) — asserted by a dedicated unit test.
- **`SanitizedNode`s carry no values.** The remote planner sees field semantics
  (tag/type/label/name), a `filled` boolean and a CSS selector — never a value. A
  label/name crosses only when the M2 detector finds nothing in it (fail closed,
  gated in `toSanitizedNodes`).
- **Two-stage validation, then LOCAL resolution, then execution.**
  `actions/validate.ts` (pure): schema (exact shapes, no extra fields — a malicious
  planner cannot smuggle payload) and policy (NAVIGATE only to allowlisted https
  origins — default-deny; bounded SCROLL; TYPE/SELECT values must be an alias or scan
  clean against `detectPII`, so a hallucinating/malicious planner cannot type a raw
  protected value). `actions/index.ts` bridge: schema → policy → vault.resolve (alias
  → value, on-device, latest possible moment) → content-script execution. Unknown or
  expired aliases fail closed (`ALIAS_UNKNOWN`).
- **Firewall = structure + alias grammar + content scan.** `firewall/inspect.ts` fails
  closed unless the payload is EXACTLY a `RemoteAgentRequest` (no missing/extra keys),
  every alias matches `USER_<CATEGORY>_<n>`, and the same local detector (M2) scans
  clean over every text-bearing string. Honest limit (documented, §13): it cannot
  prove absence of PII the detector does not recognize; that risk is bounded upstream
  by `enforcePrivacy` withholding `sanitizedText` unless the page was fully enforced.
- **No-progress guard.** Executing the identical action twice in a row (e.g. a submit
  button that never disables) stops the loop with `max_steps/NO_PROGRESS` instead of
  silently burning the step budget.
- **Fail-closed stops everywhere:** blocked page (critical credential), restricted
  surface, unenforceable findings, firewall deny, planner failure, rejected action —
  each a structured status surfaced in the UI, never retried blindly, never silent.
- **Backend mirrors the extension planner.** `backend/fastapi/app/agent.py` implements
  the same deterministic heuristics over the sanitized contract (pydantic-validated:
  alias grammar, action-kind allowlist, size caps → 422), with `AGENT_PROVIDER` as the
  S4 seam — selecting `remote` raises 501 rather than pretending (CONTRIBUTING.md §22).

### Files added

- `extension/src/actions/validate.ts`, `extension/src/actions/index.ts` (rewritten from the M0 stub)
- `extension/src/agent/planner.ts`, `extension/src/agent/remote.ts`, `extension/src/agent/loop.ts`, `extension/src/agent/index.ts` (rewritten from the M0 stub)
- `extension/src/firewall/inspect.ts`, `extension/src/firewall/index.ts` (implemented from the M7 seam — required for any egress)
- `extension/src/sidepanel/AgentTask.tsx`
- `backend/fastapi/app/agent.py`, `backend/fastapi/tests/test_plan.py`
- `tests/unit/{agent-planner,actions-validate,firewall,agent-loop}.test.ts`
- `tests/integration/agent-leakage.test.ts`, `tests/e2e/agent-task.spec.ts`
- `.github/workflows/ci.yml`

### Files modified

- `extension/src/types/contracts.ts` — additive M6 types (`SanitizedNode`); `RemoteAgentRequest.sanitizedPageStructure` narrowed from `unknown[]` to `SanitizedNode[]` (nothing else constructed it yet)
- `extension/src/types/messages.ts` — additive `EXECUTE_ACTION` channel + `FieldStructure` on `ScanPageResponse` (raw, INTERNAL-ONLY, same boundary as `pageText`)
- `extension/src/content/index.ts` — structure collection + constrained `EXECUTE_ACTION` executor (CLICK/TYPE/SELECT/SCROLL/NAVIGATE only; structured outcome codes; never evaluates page strings)
- `extension/src/background/index.ts` — `EXECUTE_ACTION` relay via the existing hardened relay path (no new permissions)
- `extension/src/sidepanel/App.tsx` — 2 lines (import + `<AgentTask />`)
- `backend/fastapi/app/main.py` — added `POST /v1/plan`; `/health` untouched

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass (0 errors) |
| Lint | `npm run lint` | ✅ pass (0 errors) |
| Unit + integration | `npm test` | ✅ **308 passed / 308** (31 files; was 271 — +37 new) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **13 passed / 13** (was 12 — +1 agent-task spec) |
| Backend | `pytest -q` (backend/fastapi) | ✅ **9 passed / 9** |
| CI | `.github/workflows/ci.yml` | added (node gates, backend pytest, e2e job) |

### Privacy verification (canary-based, CONTRIBUTING.md §13)

`tests/integration/agent-leakage.test.ts` plants synthetic canaries
(`CANARY_EMAIL_001@example.test`, `555-123-4567`) in the page text of a full
fill-and-submit run and asserts: (1) `fetch`/XHR/WebSocket/`sendBeacon` are stubbed to
THROW and are never hit — the deterministic loop performs zero network I/O; (2) step
records and every observed outbound request contain the aliases but never the canaries;
(3) alias→value mappings exist only in the local vault; (4) console spies see no
canary; (5) the remote gateway transmits ONLY after a firewall allow verdict, sends the
inspected payload verbatim, refuses on deny, and rejects malformed planner responses.
A source scan proves the firewall/validator/planner/loop modules contain no
`console.*`/network/storage calls.

### Known limitations

- **No LLM provider yet.** The remote planner provider is a loud 501 seam (`S4`); the
  Ollama/VLM adapter (`qwen2.5vl:7b`, JSON-schema-constrained) lands next. The
  deterministic planner fully drives the demo.
- **The agent loop uses DOM signals only.** M3 visual/OCR findings are part of the
  scan-time pipeline but are not fed into per-step enforcement (cost/latency); a page
  whose sensitive data exists ONLY inside images is filled-blank by the planner. Documented, not hidden.
- **The firewall cannot prove absence of undetectable PII** (free-text names etc.) —
  bounded upstream by `enforcePrivacy`'s withhold-cleartext gate; stated honestly.
- **NAVIGATE is default-denied** (empty allowlist) — no e2e coverage of allowed
  navigation yet; the validator is unit-tested.
- **Below-fold controls** appear in the structure (whole-document query) but the
  planner has no scrolling strategy of its own yet; SCROLL exists and is validated but
  the deterministic planner never emits it.

---

## 9g. Milestone 7 — telemetry, PrivAgent-Bench, leakage sentinel measurement

_Added 2026-09-01. All numbers below were actually measured in this workspace; nothing is
claimed that was not run (CONTRIBUTING.md §22)._

### Scope

The M7 milestone from `docs/architecture.md`: the **telemetry/audit-log module** and the
**PrivAgent-Bench** benchmark harness (blueprint §10/§11/§7) that turns the privacy and
utility claims into MEASURED numbers, plus `docs/benchmark.md` as the benchmark
specification.

### Design decisions

- **Telemetry is value-free BY CONSTRUCTION** (`extension/src/telemetry/index.ts`): the
  recorder copies a fixed allowlist of fields (`type`, `entityCategory`, `alias`,
  `timestamp`) and drops everything else, so no caller can smuggle a raw value into the
  log. Timings are name+milliseconds only. In-memory, session-scoped, bounded buffers
  (1,000 entries, oldest evicted — same volatility philosophy as the vault, R15).
  `exportSummary()` exposes counts + p50/p95/max percentiles only.
- **Agent loop instrumented**: `AgentRunResult.stageMs` now carries cumulative
  scan/enforce/plan/execute/total durations (blueprint §10 "local inference latency");
  the panel displays total local time.
- **PrivAgent-Bench fixtures** (`benchmark/fixtures.json`): the eight §10 page/task
  families with difficulty levels, synthetic uniquely-identifiable canaries
  (`BENCH_*`, Invariant 6), and §5-style safe-item false-positive controls (prices,
  order/product/ledger IDs, dates).
- **The leakage sentinel MEASURES, it does not assert** (`benchmark/run.ts`):
  `runLeakageProbe` drives the REAL loop over each fixture page, captures every
  outbound request, and searches payloads + step records for exact/case/URL-encoded
  canary variants — the §7 leakage rate is computed, and a non-zero rate is a benchmark
  FINDING (that is exactly how it caught the name-leak below).
- **§11 three-way comparison is generated per page**: no-protection vs full-redaction
  vs PrivAgent — payload bytes AND fillable sensitive slots, producing the data for the
  blueprint's "winning graph".
- **Multi-signal detection added where the sentinel caught a real leak** (blueprint
  §5): during bench development the sentinel measured a 0.25 leakage rate on the
  registration page — planted person-name values rode verbatim inside
  `sanitizedVisibleText` because no pattern matches a name. `detectLabeledValues`
  (strict `Name:`/`Patient:`/`Student:`/`Address:` label evidence + credential keywords
  with whitespace separators) now feeds the loop and the recall evaluation. This is the
  honest §5 ablation ("context-aware vs pattern matching") starting to exist.

### Files added

- `benchmark/fixtures.json`, `benchmark/run.ts`
- `tests/benchmark/rubric.bench.ts`, `vitest.bench.config.ts` (`npm run bench`)
- `tests/unit/telemetry.test.ts`, `tests/e2e/bench-tasks.spec.ts`
- `docs/benchmark.md`

### Files modified

- `extension/src/telemetry/index.ts` — implemented from the M7 stub
- `extension/src/agent/loop.ts` — `stageMs` timings + multi-signal entity collection
- `extension/src/perception/pii/index.ts` — additive `detectLabeledValues`
- `extension/src/sidepanel/AgentTask.tsx` — shows total local time
- `package.json` — `bench` script; `tsconfig.json` — includes the bench config
- `.github/workflows/ci.yml` — `benchmark` job with artifact upload

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **315 passed / 315** (was 308 — +7 telemetry) |
| Bench | `npm run bench` | ✅ 3 passed (golden gates: recall/FPR/leakage/task-success) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **17 passed / 17** (was 13 — +4 real-extension bench tasks) |
| Backend | `pytest -q` | ✅ 10 passed / 10 |
| CI | benchmark job + artifact upload added | ✅ |

### Measured results (full details in docs/benchmark.md + reports artifact)

- PII recall **100%** (25/25 planted items across 5 categories, multi-signal)
- False-positive rate **0%** (16 safe controls)
- Leakage rate **0%** (8 pages × full agent runs, sentinel-measured)
- Task success rate **100%** (4 DOM-feasible families, REAL extension e2e)
- Credential-bearing pages: **fail-closed blocked, 0 bytes transmitted** (4/4)
- §11 comparison: PrivAgent preserves all fillable slots at ~160 B where full redaction
  preserves 0 slots — the measured "winning graph" direction
- Local inference latency p50 ≈ 0.01 ms/page (node-side pipeline)

### Known limitations

- Free-text values with NO introducing label and NO reliable pattern (a name mid-sentence)
  remain undetectable — documented boundary; NLP/context classification is future work.
- Resource utilization (rubric #4) currently measures bundle size, per-stage durations
  and request bytes; `performance.memory` is measured only when present; CPU/GPU/RAM on
  target hardware is not instrumented yet.
- Latency is node-side; full in-browser per-stage telemetry UI lands with the dashboard.
- Visual-only (canvas/image) pages are not yet part of the task-success metric.

---

## 9h. Telemetry dashboard (rubric #4 evidence, UI)

_Added 2026-09-01, same session as §9g._

### Scope

The side panel now SURFACES the M7 telemetry: a `Telemetry` dashboard section showing
privacy-event counts (DETECTED/SANITIZED/BLOCKED/ALIAS_RESOLVED/TASK_RESULT) and
per-stage timing percentiles (p50/p95/max) — the visible, live evidence for the
client-side resource-utilization metric.

### Design decisions

- **Session telemetry singleton** (`sidepanel/telemetry-session.ts`): one `Telemetry`
  instance shared by the scan pipeline and the agent task, wrapped with a minimal
  pub-sub; React reads it through `useSyncExternalStore`. The value-free guarantee
  stays in the recorder — the wrapper only fans out notifications.
- **Pipeline instrumentation**: `App.runScan` records `scan.detect`/`scan.visual`/
  `scan.enforce`/`scan.total` timings and DETECTED (per category, normalized via
  `toSensitiveCategory`) / SANITIZED / BLOCKED events; the agent task records
  `agent.*` stage timings (from `AgentRunResult.stageMs`), ALIAS_RESOLVED (alias only)
  and TASK_RESULT events.
- The dashboard can only ever show counts and milliseconds — the recorder's
  allowlist-copy makes a raw-value leak into the UI structurally impossible, and the
  e2e asserts the planted raw values never appear in the dashboard text.

### Files

- Added: `extension/src/sidepanel/telemetry-session.ts`, `extension/src/sidepanel/TelemetryPanel.tsx`,
  `tests/unit/telemetry-session.test.ts`, `tests/e2e/telemetry-panel.spec.ts`
- Modified: `extension/src/sidepanel/App.tsx` (instrumentation + mount),
  `extension/src/sidepanel/AgentTask.tsx` (events + timings)

### Validation results — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **318 passed / 318** (+3) |
| Build | `npm run build` | ✅ pass |
| E2E | `npm run e2e` | ✅ **18 passed / 18** (+1: dashboard fills from scan + agent run, value-free, reset works) |
| Backend | `pytest -q` | ✅ 10 passed / 10 |

### Known limitations

- Telemetry is session-scoped in memory (resets on panel reload) — by design (R15);
  persistent audit export remains future work.
- Timings cover the local pipeline; full network-byte accounting per outbound request
  is available in the bench, not yet surfaced live in the panel.

---

## 9i. Visual-context accuracy measured (rubric #1) — live OCR verification closed

_Added 2026-09-01, same session as §9h._

### Scope

The last unmeasured rubric line (#1, 25%): pages whose sensitive values exist ONLY as
painted pixels. A new e2e suite (`tests/e2e/visual-accuracy.spec.ts`) renders canvas-only
pages, runs the REAL local pipeline (scan + visual check), and measures category-level
accuracy via a value-free stats seam (`sidepanel/visual-stats.ts`: per-category counts
only — recognized text/bboxes are never exposed, matching what the agent itself sees).

### Root cause found and fixed en route

The structural analysis budget (`MAX_ANALYSIS_EDGE = 192`) shrank 642px canvases to
192px — 28px text became ~8px, unreadable. `OCR_ANALYSIS_EDGE = 1024` is now used for
the analysis raster ONLY when a content analyzer is registered; the default no-engine
pipeline is byte-identical to before.

### Measured

- contentStatus `ok` — the Tesseract.js wasm engine verifiably runs in headless Chromium
  (closes the §0 "pending manual Chrome verification" item)
- Category-level accuracy **100%** (2/2 pages: EMAIL+PHONE, PAYMENT), 0 false positives
- Scan summary shows `OCR_REGION_n` masked rows with `textCount: 0` (visual-only proof)

### Files

- Added: `tests/e2e/visual-accuracy.spec.ts`, `extension/src/sidepanel/visual-stats.ts`
- Modified: `extension/src/perception/visual/regions.ts` (`OCR_ANALYSIS_EDGE`),
  `extension/src/perception/visual/service.ts` (conditional elevation),
  `extension/src/sidepanel/{VisualStatus,App}.tsx` (stats recording),
  `docs/benchmark.md` (rubric #1 section)

### Validation — actually executed

typecheck ✅ lint ✅ vitest **318/318** ✅ bench 3/3 ✅ build ✅ e2e **21/21** (+4) ✅
backend 10/10 ✅ — reports: `benchmark/reports/visual-accuracy.{json,md}`

---

## 9j. Below-fold scrolling, allowlisted navigation, repo organization, CI fix

_Added 2026-09-01/02, same session as §9h/§9i._

### Scope

Three planner/loop capability gaps closed, one CI defect fixed, and the repository
reorganized for handoff.

### What landed

- **Below-fold scrolling**: `SanitizedNode.belowFold` (viewport-relative, recomputed on
  every observation) → the deterministic planner emits one bounded `SCROLL(720)` before
  interacting with below-fold controls; the re-observation decides when to stop
  scrolling. Repeated scrolls are exempt from the no-progress guard (scrolling IS
  progress-seeking); the step budget still bounds them. The executor also
  `scrollIntoView`s before TYPE/CLICK/SELECT. E2E: a 1200px-tall page is filled and
  submitted end-to-end (`below-fold.spec.ts`).
- **Allowlisted NAVIGATE**: `RemoteAgentRequest.pageOrigin` (origin-only, value-free,
  firewall-validated as such) + a NAVIGATE rule that emits ONLY origins taken from the
  local policy allowlist and named in the task — never an invented URL, never when
  already on the target. The loop derives a same-origin default allowlist (fail-closed
  empty) and shares it with the bridge's per-execution policy provider; the panel reads
  a user-configured allowlist from `chrome.storage.sync` (default empty). E2E:
  portal.test → privagent.test navigation + fill + submit (`navigation.spec.ts`).
- **CI fix**: the `node` job ran `npm test` BEFORE `npm run build`; the
  built-extension integration suite validates the BUILT `dist/` manifest and failed on
  every clean checkout since M6 (5 red runs). Build now precedes tests; the run on
  this commit is the regression proof.
- **Repo organization**: `CLAUDE.md` → `CONTRIBUTING.md` (tool-neutral engineering
  rules; section numbers unchanged — 51 files of references swept); new `AGENTS.md`
  agent entry point; blueprint PDF moved to `docs/`; README updated.
- **Firefox spike (time-boxed)**: `scripts/build-firefox.mjs` post-processes `dist/`
  into `dist-firefox/` — event-page background (the CRXJS loader's import target is
  inlined; the script refuses module syntax), `sidebar_action` instead of the
  `sidePanel` permission, `browser_specific_settings.gecko.id`. `npm run build:firefox`.

### Validation — actually executed

typecheck ✅ lint ✅ vitest **324/324** (+6) ✅ bench 3/3 ✅ build ✅ e2e **22/22** (+2:
below-fold, navigation) ✅ backend 10/10 ✅ · `npm run build:firefox` produces a valid
Firefox MV3 structure ✅

### Known limitations

- Firefox: NOT executed in a real browser (Playwright cannot load extensions in
  Firefox); manual path = `web-ext run --source-dir dist-firefox`. The toolbar-click
  panel-open is Chrome-only — Firefox users open the sidebar manually.
- Same-origin default navigation: cross-origin agent flows require the user-configured
  allowlist (storage key `navigationAllowlist`).
- Below-fold interaction assumes viewport-height scrolls; extremely tall/lazy pages may
  consume the step budget (bounded, honest).

---

## 9k. On-device face detection (ONNX WASM), page-type classification, policy gate

_Added 2026-09-02. All gates below were actually executed (CLAUDE.md→CONTRIBUTING §22)._

### Scope

M7.5 milestone: on-device BlazeFace face detection + blurring via ONNX Runtime Web
(WASM backend ONLY — WebGPU is unstable in MV3 contexts and fails silently), a
rule-based page-type classifier wired into the policy layer, and the model/runtime
build plumbing. Zero remote calls.

### Design decisions

- **Face blur runs in the side panel, not the offscreen document.** The M3
  split-by-context decision put rasterization + analysis in the panel; the face-blur
  step consumes THAT raster where it lives. Moving inference to the (unregistered M0)
  offscreen document would add a cross-document pixel message path and a new
  permission for zero capability gain. The offscreen doc stays reserved (its M0
  header says the same).
- **Model source deviation, documented**: the spec named PINTO_model_zoo
  `307_BlazeFace` — the directory is `030_BlazeFace` and its model tarball is served
  from an S3 host blocked by the build sandbox. A reachable end-to-end export with an
  IDENTICAL runtime contract was used instead (NCHW `[1,3,128,128]` input; graph-baked
  0.7 threshold + NMS; [N,16] normalized output rows). `scripts/fetch-blazeface.sh`
  tries the PINTO source first, then the mirror.
- **Normalization evidence beats the brief**: the brief said [0,1]; the exporter's own
  notebook normalizes `x/127.5 - 1.0` → [-1,1] (MediaPipe TFLite heritage).
  CONTRIBUTING §3 (never invent) — evidence wins; the constant is isolated in
  `preprocessRaster`.
- **Engine is runtime-agnostic**: `createFaceBlurEngine({createSession})` accepts any
  `FaceSessionLike` (minimal `{inputNames, run}` shape); the real ORT session is
  wrapped into it. Tests mock the session entirely (ONNX WASM cannot run under Vitest)
  and the pre/post-processing, parsing and pixel-blur functions are pure and directly
  tested. Model absence → `FACE_BLUR_UNAVAILABLE` trace once, zero faces, pipeline
  continues (availability remembered — no retry spam).
- **Page classifier is rule-based by design** (the brief itself rules out
  MobileViT-XXS: an ImageNet classifier cannot classify page types). Priority order
  payment → auth → form → medical → general with the spec'd confidences; TODO marks
  the MobileViT ONNX upgrade path in `pageClassifier.ts`.
- **Policy gate never weakens a BLOCK**: payment/auth page types floor the overall
  decision at SANITIZE and add the `visual_high_risk` signal; an existing BLOCK
  survives (fail closed, Rule 7). `visualContext` travels on `PolicyReport`
  (informational, value-free — categories only).
- **PART D (CSP)**: the manifest CSP already carries `'wasm-unsafe-eval'` (set for
  Tesseract) — the ORT WASM backend needs nothing more. `web_accessible_resources`
  was deliberately NOT added: the model/runtime are fetched by the extension's own
  panel page, which needs no WAR — exposing them to web pages would be a
  fingerprinting surface.

### Files

- Added: `extension/src/perception/visual/faceBlur.ts`, `extension/src/perception/visual/pageClassifier.ts`,
  `extension/src/perception/visual/models/README.md`, `scripts/fetch-blazeface.sh`,
  `tests/unit/perception/visual/{pageClassifier,faceBlur,policy-visual-context}.test.ts`
- Modified: `extension/src/types/contracts.ts` (`VisualPageType`, `PageClassification`,
  `visual_high_risk` signal, `PolicySignals.visualContext`, `PolicyReport.visualContext`,
  `VisualPerceptionResult.faceStats`), `extension/src/policy/index.ts` (page-type gate),
  `extension/src/perception/visual/service.ts` (blur-before-OCR + `faceStats`),
  `extension/src/agent/loop.ts` + `extension/src/sidepanel/App.tsx` (classification wiring),
  `extension/src/diag/ocr-trace.ts` (face-blur stages), `vite.config.ts` (ONNX asset copy),
  `package.json` (`onnxruntime-web ^1.18.0`)

### Validation — actually executed

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | ✅ pass |
| Lint | `npm run lint` | ✅ pass |
| Unit + integration | `npm test` | ✅ **342 passed / 342** (+18: classifier, face engine, policy gate) |
| Bench | `npm run bench` | ✅ 3 passed |
| Build | `npm run build` | ✅ pass (`dist/ort/` copied; model optional) |
| E2E | `npm run e2e` | ✅ **23 passed / 23** |
| Backend | `pytest -q` | ✅ 10 passed / 10 |

### Runtime verification — NOW REAL (2026-09-02, same session as §9k)

A dedicated e2e (`tests/e2e/face-detection.spec.ts`) renders a REAL face
(`person.jpg`, the exact image the model exporter's own notebook used) and drives the
full pipeline in headless Chromium: BlazeFace (ONNX WASM, on-device) **detected the
face and blacked it out before OCR** — `faceStats.facesDetected >= 1`,
`facesBlurred >= 1`, `contentStatus: 'ok'`. Measured, not inferred.

Three real defects were found and fixed while proving this:
1. **Partial ORT runtime copy**: ORT 1.29 dynamically imports the glue by runtime-
   selected name (e.g. `ort-wasm-simd-threaded.jsep.mjs`); shipping only the base pair
   failed with a "dynamically imported module" backend error. The build now copies
   EVERY `ort-wasm*.{mjs,wasm}` variant.
2. **Input-name matcher**: the model's image input is named `image`, not `input` — the
   keyword matcher silently missed it and returned zero faces. `pickImageInput` now
   accepts both spellings.
3. **Nearest-neighbour downscale** lost face detail; bilinear interpolation (the
   exporter's own `cv2.resize` default) is used.

### Known limitations

- A cartoon "synthetic face" is deliberately NOT used as the fixture (BlazeFace is
  trained on real faces; claiming otherwise would be fabrication) — the fixture is a
  real face photo.
- The end-to-end model reports detections WITHOUT per-face scores (threshold + NMS are
  in-graph) — `facesDetected`/`facesBlurred` counts are the honest surface.
- Page classifier sees DOM structure/text only; canvas-only page types are invisible to
  it (documented; MobileViT upgrade path marked in code).

---

## 10. Corrections to earlier milestone claims

Recorded for honesty (CONTRIBUTING.md §22) — these were found while starting M3, not introduced by
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

**M6 — agent loop, action bridge, firewall seam, backend planner.** COMPLETE and
verified (see §9f). The two integration points left open by §9c are now closed:
(1) the loop assembles a `RemoteAgentRequest` from `enforcePrivacy` output and (2)
every outbound payload passes the implemented fail-closed firewall
(`extension/src/firewall/inspect.ts`).

The next milestone is **not started** and, per CONTRIBUTING.md §24, will not begin
until explicitly requested. Natural follow-ups, in rough order:

1. **S4 — remote provider adapter:** Ollama (`qwen2.5vl:7b`) behind
   `AGENT_PROVIDER=remote` (the 501 seam in `backend/fastapi/app/agent.py`),
   JSON-schema-constrained actions, retries/timeouts; e2e against the live backend.
2. **M7 — telemetry + leakage sentinel:** persist `PrivacyEvent`s (structured,
   value-free), benchmark harness over `benchmark/` pages, canary reports.
3. **Loop hardening:** visual/OCR signals in per-step enforcement, planner-driven
   SCROLL for below-fold controls, allowlisted navigation coverage in e2e.