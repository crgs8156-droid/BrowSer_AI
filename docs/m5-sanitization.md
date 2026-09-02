# M5 — Complete Sanitization & Privacy Enforcement

Status: implemented. Last updated 2026-08-30.

This document records what the M5 sanitization/enforcement layer does, the
contract it exposes, how it handles text and visual regions across multiple and
overlapping findings, the privacy guarantees it holds, and the browser
boundaries it explicitly does **not** cross. It consumes M4's per-finding
decisions and is consumed by a later runtime/firewall milestone.

---

## 1. What M5 is for

M4 decides *how the current context should be treated* and emits a per-finding
decision for **every** applicable finding/region. M5 answers the next question:
**given those approved decisions, neutralise every applicable finding so no raw
protected value can reach a downstream browser AI agent — for both textual and
visual regions.**

M5 is the enforcement step, not a detector. It runs no OCR, no vision model, no
AI inference, and no network call. It reduces what already exists:

- the M4 `PolicyReport` (produced internally by calling `decidePolicyReport`),
- the raw `SensitiveEntity[]` that produced those findings (so a text finding
  can recover the value it must redact, via `findingId → SensitiveEntity.id`),
- the visible `pageText` that would otherwise be sent.

Its single entry point is:

```ts
enforcePrivacy(input: EnforceInput): Promise<EnforcementResult>
```

exported from `extension/src/sanitizer` (implemented in
`extension/src/sanitizer/enforce.ts`).

Like M4, M5 adds nothing to any shipped code path until a later milestone imports
it (see §11).

---

## 2. The contract

### 2.1 Input

```ts
interface EnforceInput {
  signals: PolicySignals;   // the same { entities?, visual?, restricted? } M4 consumes
  pageText: string;         // the visible text that would otherwise be sent
  sessionId: string;        // vault scope; mappings are cleared per session
  vault: LocalVault;        // local alias↔value store; never serialised or transmitted
  now?: () => number;       // injectable clock for AliasRecord.createdAt (defaults to Date.now)
}
```

M5 does **not** define a duplicate signal/finding type. It reuses `PolicySignals`,
`PolicyReport`, `FindingDecision`, `PolicyRegionRef`, and `SensitiveEntity` from
the M1–M4 contracts unchanged.

### 2.2 Output

```ts
interface EnforcementResult {
  sanitizedText: string;              // aliased visible text, or '' when the page is not certifiably safe
  aliases: AliasBinding[];            // { alias, category } — types only, never values
  visualMasks: VisualMaskDirective[]; // overlap-merged geometry-only mask directives
  findings: FindingEnforcement[];     // exactly one entry per M4 finding — none is ever dropped
  blocked: boolean;                   // a page-level or per-finding BLOCK was present
  restricted: boolean;                // the surface is browser-restricted / could not be fully inspected
  enforced: boolean;                  // true only if every finding was neutralised AND the page is not uncertain
  local: true;                        // computed entirely on-device
}
```

Everything in an `EnforcementResult` is safe to inspect and hand toward the
remote boundary: it contains aliases, geometry, and per-finding dispositions
only — never a raw value, pixels, or a screenshot.

### 2.3 Per-finding disposition

Each M4 finding becomes exactly one `FindingEnforcement` carrying a
`disposition`:

| disposition    | meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `aliased`      | recoverable raw text value replaced by a semantic alias (stored in vault) |
| `masked`       | visual region scheduled for pixel masking (geometry preserved)          |
| `flagged`      | malformed/unparseable finding kept for caution; not neutralisable       |
| `inaccessible` | finding references content M5 can neither redact nor mask; fail closed  |

`flagged` and `inaccessible` are honest "could not neutralise" states — they are
kept, never silently dropped, and they prevent the page from being certified
(`enforced = false`).

---

## 3. Text sanitization

Text handling lives in `extension/src/sanitizer/alias.ts` and is driven by
`enforcePrivacy`.

1. **Recover the value.** Entities are indexed by `id` (only well-formed entities
   with a non-empty string `id`). A finding's `ref.findingId` looks up its entity;
   the raw value is `entity.text` when it is a non-empty string.
2. **Decide to redact.** A value is redacted when the finding's action is `WARN`,
   `SANITIZE`, or `BLOCK` (i.e. anything M4 flagged). `ALLOW` findings are left in
   place.
3. **Normalise the category.** `toSensitiveCategory` maps M2 detector variants to
   the declared `SensitiveCategory` set (e.g. `PHONE_NUMBER → PHONE`,
   `PAYMENT_CARD → PAYMENT`, `CREDENTIAL → PASSWORD`). An unknown category falls
   back to `CUSTOM` — it never guesses "non-sensitive".
4. **Allocate a stable alias.** `createAliasAllocator` returns `USER_<CATEGORY>_<n>`
   (e.g. `USER_EMAIL_1`). The same value re-uses its alias within the pass
   (stability); each distinct value in a category gets the next index
   (uniqueness). The alias contains no fragment of the secret.
5. **Store the mapping locally.** `alias → value` is written to the `LocalVault`
   (in-memory `Map`, session-scoped). The mapping never leaves the device.
6. **Rewrite the text.** `redact(pageText, pairs)` replaces every occurrence of
   each value with its alias using literal `split`/`join` (no regex — no ReDoS,
   no escaping pitfalls), applying **longest value first** so a value that is a
   substring of another cannot corrupt the result.

The alias directory returned to the caller (`aliases`) is
`AliasBinding[] = { alias, category }` — types only. The mapping back to the real
value exists **only** in the vault, reachable only via the alias.

---

## 4. Visual-region sanitization

Visual handling lives in `extension/src/sanitizer/mask.ts`.

A visual finding carries geometry (`ref.bbox`) but no text. M5 turns it into a
`VisualMaskDirective` (`{ bbox, findingIds, source }`) — geometry only. For local
pixel buffers, `applyMasks(buffer, regions)` returns a **copy** of the buffer with
each region filled opaque black (`0,0,0,255`), clipped to buffer bounds, and never
mutates the input.

**Design boundary (important and deliberate).** `RemoteAgentRequest` has **no
image field**: no image, screenshot, or raster ever crosses the remote boundary
by construction. M5's visual enforcement is therefore two local mechanisms —
(a) geometry-only mask *directives* for a downstream local consumer, and (b) a
local pixel-mask primitive for any local buffer. M5 does **not** transmit images
and does not claim to "scrub an outbound image", because there is no outbound
image to scrub. This keeps the visual guarantee honest: the protection is
enforced where pixels actually live (locally), not asserted about a channel that
does not exist.

---

## 5. Multi-region and overlap handling

- **Every finding is accounted for.** `result.findings.length` equals
  `decidePolicyReport(signals).findings.length`. No finding is filtered, deduped
  away, or silently dropped — including malformed (`flagged`) and unresolvable
  (`inaccessible`) ones.
- **Findings at different positions / different regions** stay distinct.
  Far-apart visual regions remain separate directives; text values at different
  offsets are each redacted at every occurrence.
- **Overlapping regions merge deterministically.** `mergeMaskRegions` clusters
  overlapping bounding boxes into their **union** and iterates to a fixpoint, so a
  bridged chain (A∩B, B∩C, A∩C = ∅) coalesces into one directive. The merged bbox
  is never smaller than the sum of the sensitive areas — the union stays
  protected. All contributing `findingIds` are preserved on the directive. A merge
  spanning mixed perception sources is reported as `FUSED`. Directives are sorted
  top-to-bottom then left-to-right for determinism.
- **Overlapping text values** are handled by the longest-first redaction order
  (§3, step 6), so one value being a substring of another cannot corrupt output.

---

## 6. Fail-closed behaviour

M5 certifies a page as safe only when it can actually establish safety
(CONTRIBUTING.md §5 Rule 7):

- `blocked` — true when the page-level decision is `BLOCK` **or** any finding's
  action is `BLOCK` (e.g. a critical credential).
- `restricted` — true when `signals.restricted` is set **or** the overall reason
  is `RESTRICTED_CONTEXT`.
- `enforced` — true only when **every** finding's disposition is `aliased` or
  `masked` **and** the overall reason is not one of `SIGNAL_UNAVAILABLE`,
  `MALFORMED_SIGNAL`, or `RESTRICTED_CONTEXT`.
- `sanitizedText` — the aliased text is returned **only** when the page is fully
  safe (`enforced && !blocked && !restricted`). Otherwise M5 returns `''`. This is
  a deliberate fail-closed choice: if M5 cannot certify that the text is clean, it
  withholds the cleartext rather than risk emitting an unidentified raw value.

The caller/firewall must still refuse to send whenever `blocked`, `restricted`,
or `!enforced`.

---

## 7. Privacy / leakage guarantees

Enforced and covered by automated tests (`tests/unit/enforce.test.ts`,
`tests/unit/sanitizer.test.ts`, `tests/unit/vault.test.ts`,
`tests/integration/sanitizer-leakage.test.ts`):

- **Raw values never appear in the result.** The canary is absent from the
  serialised `EnforcementResult`, from `sanitizedText`, and from the alias
  directory. It is recoverable **only** from the vault, and only via its alias.
- **The mapping stays local.** The vault is an in-memory `Map`; `clearSession`
  wipes a session's entries. There is no `chrome.storage`, `localStorage`,
  `sessionStorage`, or `indexedDB` use (verified by a source scan).
- **No logging, no network.** The sanitizer and vault sources contain no
  `console.*`, `fetch`, `XMLHttpRequest`, `WebSocket`, or `sendBeacon` calls
  (verified by a source scan that strips comments first), and running every
  enforcement branch produces no console output and opens no network channel.
- **Synthetic canaries only** are used in tests (CONTRIBUTING.md §13/§15).

---

## 8. What M5 does NOT claim

Honesty boundaries (CONTRIBUTING.md §6, and the SIH alignment rule):

- M5 protects only what M1–M4 **actually observed**. It makes no claim of 100%
  detection accuracy and cannot protect content that was never detected.
- M5 cannot sanitize content the extension genuinely cannot access. Restricted
  surfaces and findings with neither a recoverable value nor a region are reported
  `restricted` / `inaccessible` — never falsely reported as sanitized.
- M5 does not capture screenshots and does not send images anywhere; visual
  masking operates on a **caller-supplied local pixel buffer**.
- Webpage content is untrusted data. M5 treats a finding's text purely as a value
  to alias; no webpage string can alter M5's rules or disable protection.

---

## 9. Performance and bundle impact

- The enforcement pass is O(number of findings); text redaction is linear-ish in
  the page text via `split`/`join` over the (small) set of distinct values;
  `mergeMaskRegions` iterates to a fixpoint over the (small) set of visual regions.
  Vault writes are in-memory and resolve immediately. No heavyweight AI/vision
  model and no new runtime dependency are introduced.
- **Measured production build (M5 present in the tree):** `✓ 36 modules
  transformed`, main chunk `dist/assets/index.html-*.js` 201.41 kB / gzip
  63.88 kB — **unchanged from M4**, because no shipped entry (side panel/service
  worker) imports the M5 modules yet (§11). The added surface is small, pure
  TypeScript; wiring it in later adds no third-party weight.

---

## 10. Known limitations

- **Not yet wired into the running extension.** No caller invokes
  `enforcePrivacy` today; §11 tracks that integration.
- **Literal redaction.** `redact` matches the exact value string M1/M2 recorded.
  If the visible text renders that value in a different form than the detector
  stored (e.g. reformatted), that particular rendering may not be replaced in
  `pageText`. The finding is still counted and its alias/vault entry still exist;
  this is a matching limitation, not a dropped finding.
- **In-memory, session-scoped vault.** The mapping is intentionally not persisted;
  persistence would be a separate, separately-audited decision (the mapping must
  stay local).
- **Visual masking needs a local buffer.** M5 supplies directives and a masking
  primitive; it relies on a caller to provide the local pixel buffer to mask.

---

## 11. Integration points (next milestone)

M5 leaves two integration points open, both documented and not yet built:

1. **Runtime wiring.** The side panel / service worker must call
   `enforcePrivacy`, honour its `blocked` / `restricted` / `enforced` gates, and
   assemble a `RemoteAgentRequest` from the `EnforcementResult`
   (`sanitizedText` → `sanitizedVisibleText`, `aliases` → `aliases`).
2. **Outbound privacy firewall.** The final outbound boundary (CONTRIBUTING.md §5
   Rule 6/7) that every remote request must pass through, failing closed when
   safety cannot be established.

Both uphold the same invariant M1–M5 preserve: raw protected values never reach a
remote payload, a log, or telemetry.
