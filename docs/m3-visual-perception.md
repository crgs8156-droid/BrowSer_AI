# M3 — Lightweight Local Visual Perception

Status: implemented. Last updated 2026-08-29.

This document records what M3 does, what it deliberately does **not** do, and the exact
place a real OCR / ONNX model plugs in.

---

## 1. What M3 is for

M3 supplies **local visual observations** that M4 (multimodal fusion) can consume when the
DOM alone is not enough. It answers two questions about a bounded screen region:

- does information appear to live here that the DOM cannot describe?
- what kind of information does it look like — text-like, graphic, or empty?

M3 is **not** the sensitive-data detector. It does not classify PII, does not decide
sensitivity, and does not transcribe text.

---

## 2. Pipeline order

The ordering is enforced in `service.ts` and is the whole point of the design — each step
exists to avoid doing the next, more expensive one.

| # | Step | Module | Exit status if it stops here |
|---|------|--------|------------------------------|
| 1 | Restricted-page check | `restricted.ts` | `restricted_page` |
| 2 | DOM-first sufficiency | `decision.ts` | `not_required` |
| 3 | Capability check | `capability.ts` | `unavailable` |
| 4 | Bounded region select | `regions.ts` | `not_required` |
| 5 | Capture + crop | `../screenshot`, `raster.ts` | `unavailable` |
| 6 | Unchanged-region cache | `cache.ts` | — (serves cached labels) |
| 7 | Lazy provider analysis | `providers/` | `completed` |

Step 2 is the common case. On an ordinary text page the pipeline performs **no capture, no
rasterization, and loads no provider**.

### Where each part runs

An MV3 service worker has no document, no canvas and no WebGPU, so it cannot rasterize or
analyse. Therefore:

- **Background worker** (`background/visual-messages.ts`) — brokers cheap DOM metadata only.
- **Side panel** (`sidepanel/VisualStatus.tsx`) — owns capture, cropping and analysis, because
  it is a document context.

Messaging reuses the existing `chrome.runtime.onMessage` channel with a `type` discriminator
(`COLLECT_VISUAL_CANDIDATES`), added as a second listener so M1's worker code stays untouched.
No new transport was introduced.

---

## 3. Content-driven, not website-driven

There is **no site list** anywhere in the decision path. `decision.ts` never looks at the URL.
It uses only structural facts:

- a candidate qualifies when it is ≥ 32 px on both edges, ≥ 64×64 px in area, has no
  `alt`/`aria-label`/`title`, and exposes no inner text;
- a text-sparse page (< 200 chars) whose candidates paint ≥ 15 % of the viewport qualifies via
  the painted-area fallback (this is what catches canvas/WebGL-rendered apps).

`restricted.ts` *does* contain a short host/scheme list. That is a **browser capability check**,
not a content policy: those are surfaces where the browser forbids extension scripting and tab
capture outright, so behaviour there cannot differ by choice. It is also fail-closed — an
unparseable or unreadable URL counts as restricted.

---

## 4. Privacy properties

| Invariant | How it is enforced |
|-----------|--------------------|
| Raw visual data stays local | Captures and rasters live only in `service.ts` locals; nothing returns them |
| No raw data in results | `VisualObservation` carries labels, geometry, confidence — no pixels, no text |
| No logging of visual data | Zero `console.*` statements in `perception/visual/**`, asserted by a source scan test |
| No network egress | Nothing in the pipeline performs remote I/O; the only `fetch` is a `data:` URL decode |
| Bounded exposure | ≤ 4 regions/run, longest edge ≤ 192 px, one capture per run |
| Cache holds no pixels | Only a 32-bit digest + derived labels |

Verified by `tests/integration/visual-leakage.test.ts`. Those assertions were
**mutation-tested**: injecting a `console.log` of the capture, and placing capture bytes into
the result, each caused the expected failures.

`chrome.tabs.captureVisibleTab` only returns whole visible tabs — Chrome has no partial-capture
API. Cropping therefore happens immediately after decode in `raster.ts`, and the full capture is
never handed to a provider.

---

## 5. OCR / model integration point

**There is no bundled OCR engine or ONNX model at M3.** This was a deliberate decision, not an
omission.

### Why deferred

- No OCR/vision dependency existed in the project (verified: no `tesseract.js`, no
  `onnxruntime-web`).
- MV3 forbids remote code, so a WASM OCR engine plus its language data must be **bundled**
  locally — multiple MB against a current total bundle of ~215 kB.
- Fetching model/language data at runtime would add a new outbound network path to a
  privacy-critical extension.
- The brief's instruction: if a real model would make M3 excessively large or unstable, do not
  force it — implement the abstraction and document the integration point.

### What exists instead

`providers/pixel-stats.ts` — a real, dependency-free analyzer. It computes luminance variance,
horizontal edge density, and row-brightness transitions **on actual pixels** and returns a
coarse structural label. It is honest about its limits: confidence is capped at **0.75**, and it
reports `source: 'vision'`, never `'ocr'`, because it does not read text.

### How to plug in a real engine

Two independent seams:

Model artifacts belong in `models/onnx/` and configs in `models/configs/` — both already
exist, are git-ignored, and are marked "populated in M4" by the scaffold. Weights must be
**bundled as extension assets**, never fetched at runtime.

**A. Structural/visual model (ONNX).** Register a provider; nothing else changes:

```ts
import { registerVisualProvider } from './extension/src/perception/visual';

registerVisualProvider(async () => {
  const ort = await import('onnxruntime-web');           // lazy: not loaded until first region
  const session = await ort.InferenceSession.create('/models/detector.onnx', {
    executionProviders: ['webgpu', 'wasm'],              // WebGPU preferred, WASM fallback
  });
  return {
    name: 'onnx-text-detector',
    source: 'vision',
    async analyze(raster, region) { /* → VisualObservation[] */ },
    dispose: () => session.release(),
  };
});
```

The service already passes the resolved backend (`'webgpu' | 'wasm' | 'cpu'`) into `analyze()`,
and calls `dispose()` on teardown.

**B. Text recognition (OCR).** Register a recognizer in `perception/ocr/index.ts`:

```ts
import { registerOcrRecognizer } from './extension/src/perception/ocr';

registerOcrRecognizer(async () => {
  const engine = await createLocallyBundledOcr();        // wasm + language data from extension assets
  return { name: 'local-ocr', recognize: (image) => engine.run(image), dispose: () => engine.terminate() };
});
```

With nothing registered, `recognize()` returns `[]`.

> The earlier scaffold returned a hard-coded `'Sample OCR Text'` for any input. M3 removed it.
> Fabricated transcription would become fabricated evidence for M4's sensitivity decisions and
> could mask a real leak. `tests/unit/ocr.test.ts` asserts that string can never come back.

**Anything registered here inherits the privacy obligations:** OCR output is derived from page
pixels and must be treated as raw protected content — local only, never logged, and never placed
on a remote payload without sanitization and the privacy firewall (M5/M7).

---

## 6. Measured cost

From `npm run build` (real output, before → after M3):

| Artifact | Before | After | Δ |
|----------|--------|-------|---|
| Side panel chunk | 191.21 kB | 201.41 kB | +10.20 kB |
| Side panel (gzip) | 60.32 kB | 63.88 kB | +3.56 kB |
| Service worker | 0.51 kB | 2.02 kB | +1.51 kB |
| `pixel-stats` (lazy chunk) | — | 1.49 kB | new, on-demand |
| Total `dist` | 200.28 kB | 214.87 kB | +14.59 kB |

No new npm dependency; no model downloaded. The separate `pixel-stats` chunk is the build
proving laziness — the analyzer is not in the panel's initial bundle.

Runtime cost is bounded by construction rather than measured on live pages: ≤ 4 regions per
run, each downscaled to ≤ 192 px on its longest edge, one capture per run, and unchanged
regions skipped entirely.

---

## 7. Test coverage, and what is not yet verified

Executed and green (see PROJECT_STATUS.md for the numbers):

- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- 92 unit + integration tests, including `tests/integration/visual-leakage.test.ts`.

**E2E is written but has never been executed.** `tests/e2e/` now loads the real built
extension into a real Chromium profile (replacing M1's placeholder, which navigated to the
literal string `chrome-extension://<extension-id>/src/sidepanel/index.html` — an
unsubstituted placeholder pointing at a path the build does not emit, so it could never have
passed). All 11 tests compile and collect, then fail identically at browser launch:

```
browserType.launchPersistentContext: spawn UNKNOWN
```

This is an OS-level execution restriction in the development environment, not a project
defect: the Chromium install is complete (428 MB, valid PE headers, readable), yet the binary
cannot be spawned, and Playwright's own `PrintDeps.exe` fails to resolve `chrome_elf.dll`
from the same directory. System executables spawn normally.

On a machine where Chromium can launch:

```bash
npm run build && npm run e2e
```

Two things the E2E suite is expected to settle, and which are therefore **still open**:

1. **Whether `chrome.tabs.captureVisibleTab` succeeds from the side panel with the current
   manifest.** `activeTab` is normally granted only after a user gesture on the extension
   action; the manifest declares `http://*/*` + `https://*/*` rather than literal
   `<all_urls>`. If capture is refused, the pipeline degrades to
   `unavailable`/`capture_failed` — correct behaviour, but it would mean visual perception
   needs the action-click gesture (or an `<all_urls>` host permission) to do real work. The
   canvas test accepts both outcomes for exactly this reason.
2. **Whether the DOM-first decision behaves the same on real layout** as on the synthetic
   snapshots in the unit tests.

Also unverified: manual in-browser validation. No claim is made that the panel has been
exercised by hand in Chrome.

---

## 8. Limitations (honest)

- **No text is read.** `text_like_content` means "looks like rendered text", not "contains X".
- **Heuristic, unbenchmarked accuracy.** No accuracy figure is claimed for the pixel-stats
  labels; no labelled dataset was used. Confidence is capped at 0.75 to reflect this.
- **Viewport only.** `captureVisibleTab` cannot see below the fold, cross-origin iframe interiors
  are opaque to the DOM collector, and DRM/protected video may capture black.
- **Not universal.** Chromium (Chrome/Edge/Brave) is the target. Firefox needs MV3 + `sidePanel`
  review; Safari is a separate port. No cross-browser claim is made beyond capability detection
  and graceful degradation.
- **Restricted surfaces are genuinely unsupported**, not worked around.
- **Scroll-dependent region ids.** Region identity includes viewport coordinates, so scrolling
  changes ids and forfeits cache reuse. Acceptable for now; revisit if it costs measurable work.
- **Concurrency is rejected, not queued.** An overlapping `run()` returns `running` rather than
  waiting.
