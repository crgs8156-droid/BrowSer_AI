// Shared data contracts (blueprint §14). Types only — no runtime logic.
// See docs/interface-contracts.md for the accompanying design notes.

export type SensitiveCategory =
  'EMAIL' | 'PHONE' | 'NAME' | 'ADDRESS' | 'PASSWORD' | 'OTP' | 'PAYMENT' | 'ID' | 'CUSTOM';

export type PerceptionSource = 'DOM' | 'OCR' | 'VISION' | 'FUSED';

export interface SensitiveEntity {
  id: string;
  category: SensitiveCategory;
  source: PerceptionSource;
  /** Local-only for protected entities; never serialized into a remote payload. */
  text?: string;
  bbox?: [number, number, number, number]; // [x, y, width, height]
  screenshotId?: string; // ID of the screenshot where the entity was detected
  confidence: number;
  reasons: string[];
  elementId?: string;
}

// ---------------------------------------------------------------------------
// M3 — Lightweight local visual perception.
//
// PRIVACY: raw visual data (viewport captures, cropped regions, raster pixel
// buffers) is LOCAL-ONLY. None of it may be placed on a RemoteAgentRequest or
// any other outbound payload, and it must never be logged. Only the derived,
// non-reversible `VisualObservation` labels below are safe to surface upward.
//
// M3 reports WHERE information appears to live and WHAT KIND it looks like.
// It deliberately does NOT classify sensitivity — that is M4's job.
// ---------------------------------------------------------------------------

/** Viewport-space rectangle, CSS pixels. */
export interface VisualRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Kind of DOM node that could hold information the DOM text layer cannot expose. */
export type VisualCandidateKind = 'image' | 'canvas' | 'video' | 'svg' | 'iframe';

/**
 * A cheap, DOM-derived description of one possible visual region.
 * Collected in the page; carries geometry and text-availability signals only —
 * never pixels.
 */
export interface DomVisualCandidate {
  kind: VisualCandidateKind;
  rect: { x: number; y: number; width: number; height: number };
  /** True when the DOM already provides alt/aria-label/title for this node. */
  hasAccessibleText: boolean;
  /** Length of DOM-readable text inside this node (0 ⇒ DOM exposes nothing). */
  domTextLength: number;
  elementId?: string;
}

/** Input to the visual-perception decision. Collected once per run. */
export interface DomVisualSnapshot {
  /** Used ONLY for browser-restriction checks. Never sent remotely. */
  url: string;
  viewport: { width: number; height: number };
  /** Total DOM-extractable text length — the primary DOM-sufficiency signal. */
  domTextLength: number;
  candidates: DomVisualCandidate[];
  /**
   * Vertical scroll offset (CSS px) of the page when the snapshot was taken. Lets
   * the service map viewport-relative candidate rects to DOCUMENT-absolute positions
   * for bounded below-the-fold band capture. Absent ⇒ treated as 0 (top of page).
   */
  scrollY?: number;
  /** Full scrollable document height (CSS px), when known. Diagnostic only. */
  documentHeight?: number;
}

/**
 * What a region looks like. Intentionally coarse: these are structural labels,
 * not transcriptions and not sensitivity verdicts.
 */
export type VisualObservationLabel =
  | 'text_like_content'
  | 'graphic_content'
  | 'low_information';

export interface VisualObservation {
  type: 'visual_observation';
  source: 'ocr' | 'vision';
  region: VisualRegion;
  observations: VisualObservationLabel[];
  confidence: number;
  /** Always true: the observation was produced entirely on-device. */
  local: true;
}

export type VisualPerceptionStatus =
  | 'not_required'
  | 'running'
  | 'completed'
  | 'unavailable'
  | 'restricted_page';

/** Real measured counters for one run. Never estimated. */
export interface VisualPerceptionMetrics {
  candidatesConsidered: number;
  regionsSelected: number;
  regionsProcessed: number;
  regionsFromCache: number;
  durationMs: number;
}

export interface VisualPerceptionResult {
  status: VisualPerceptionStatus;
  supported: boolean;
  /** Non-sensitive diagnostic code. Never contains page content. */
  reason?: string;
  /**
   * Short, non-sensitive elaboration on `reason` — e.g. the browser's own capture-failure
   * string behind a `VISUAL_CAPTURE_UNAVAILABLE`. An API diagnostic only (sanitized:
   * stripped of any `data:`/`base64`, length-capped). Never page content or pixels.
   */
  reasonDetail?: string;
  observations: VisualObservation[];
  metrics: VisualPerceptionMetrics;
  /**
   * Genuine, categorized findings from an OCR/vision content analyzer, when one is
   * registered. EMPTY when no engine is available (`contentStatus: 'not_available'`)
   * — never fabricated (CONTRIBUTING.md §22). Each finding carries document-absolute
   * geometry and its originating region id so M4/M5 can act on it independently.
   */
  contentFindings?: VisualContentFinding[];
  /**
   * Honest status of the content-analysis pass over the run's regions:
   *   - 'not_available' — no OCR/vision engine registered (the default at M3/M5);
   *   - 'ok'            — an engine ran and returned findings (possibly none);
   *   - 'failed'        — an engine was present but errored on ≥1 region (fail closed).
   * Absent when no regions were analysed.
   */
  contentStatus?: VisualContentStatus;
  /**
   * M7.5 — on-device BlazeFace (ONNX WASM) face statistics for this run: faces found
   * in the raster and how many were blacked out BEFORE the OCR analyzer saw them.
   * Counts only — never pixels, boxes, or images.
   */
  faceStats?: { facesDetected: number; facesBlurred: number };
}

/** Outcome of a genuine OCR/vision content-analysis pass. `not_available` is the
 *  honest default when no engine is bundled — the layer never pretends. */
export type VisualContentStatus = 'ok' | 'not_available' | 'failed';

/**
 * A genuine, categorized finding produced by an OCR/vision engine over one captured
 * region. Unlike a `VisualObservation` (coarse structural label), this asserts WHAT
 * kind of sensitive value was recognized and WHERE.
 *
 * PRIVACY: `text` is recognized raw content — LOCAL-ONLY. It must never be logged,
 * serialized into a remote payload, or surfaced in a summary. `bbox` is
 * document-absolute CSS px (mapped back from the analyzer's raster coordinates).
 */
export interface VisualContentFinding {
  /** Stable id of the visual region this finding was recognized within. */
  regionId: string;
  category: SensitiveCategory;
  /** 0..1 confidence reported by the engine. */
  confidence: number;
  /** [x, y, width, height] in document-absolute CSS px. */
  bbox: [number, number, number, number];
  /** Recognized text, when the engine returns it. LOCAL-ONLY raw content. */
  text?: string;
  /** Which engine produced this finding (diagnostic; never a value). */
  provider: string;
  /** Perception source (OCR vs coarse VISION). Absent ⇒ treated as VISION. */
  source?: PerceptionSource;
}

// ---------------------------------------------------------------------------
// M4 — Local privacy decision / policy layer.
//
// Consumes signals already produced by M0–M3 — PII/DOM `SensitiveEntity[]`
// (M1/M2), a `VisualPerceptionResult` (M3), and a restricted-page flag — and
// emits one deterministic, explainable `PolicyDecision`. It performs NO
// detection, NO capture, NO OCR, NO model inference and NO network I/O; it only
// decides. Being a pure consumer, it cannot cause M3 visual work to run.
//
// PRIVACY: a `PolicyDecision` carries category tags, counts, a severity and a
// non-sensitive explanation ONLY. It MUST NEVER contain a raw protected value
// (`SensitiveEntity.text`), pixels, a screenshot, or a raster. `confidence` is
// confidence in the DECISION, not a claim about detection accuracy.
// ---------------------------------------------------------------------------

/** What the extension should do about the current context's sensitivity. */
export type PolicyAction = 'ALLOW' | 'WARN' | 'SANITIZE' | 'BLOCK';

/** Coarse risk tier. `none` is used only when a signal ran and found nothing. */
export type RiskSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/** Explainable, non-sensitive reason for a decision. */
export type PolicyReasonCode =
  | 'NO_SENSITIVE_DATA'
  | 'POSSIBLE_SENSITIVE_DATA'
  | 'CONFIRMED_SENSITIVE_DATA'
  | 'CRITICAL_CREDENTIAL'
  | 'VISUAL_UNCERTAINTY'
  | 'RESTRICTED_CONTEXT'
  | 'SIGNAL_UNAVAILABLE'
  | 'MALFORMED_SIGNAL';

/** Which kinds of signal contributed to a decision — never the values. */
export type PolicySignalCategory =
  | 'credential'
  | 'payment'
  | 'identity'
  | 'contact'
  | 'personal'
  | 'dom_pii'
  | 'visual_text_like'
  | 'visual_uncertain'
  | 'visual_high_risk'
  | 'restricted_page';

// ---------------------------------------------------------------------------
// M7.5 — page-type classification (rule-based; MobileViT-XXS upgrade path).
// The classifier sees only structural DOM signals (field types/labels) and page
// text — never pixels — so its output is safe to cross the remote boundary.
// ---------------------------------------------------------------------------

export type VisualPageType = 'payment' | 'auth' | 'form' | 'medical' | 'general';

export interface PageClassification {
  pageType: VisualPageType;
  /** Confidence in THIS classification (structural/label evidence quality). */
  confidence: number;
}

/**
 * Signals handed to the policy engine. Every field is optional; absence is
 * treated as "unknown", never as "safe" (CONTRIBUTING.md §5 Rule 7 — fail closed).
 */
export interface PolicySignals {
  /** PII/DOM entities from M1/M2. `undefined` ⇒ detection did not run. */
  entities?: SensitiveEntity[];
  /** M7.5 — rule-based page-type classification, when it ran. */
  visualContext?: PageClassification;
  /** M3 result, when visual perception ran. `undefined` ⇒ it did not run. */
  visual?: VisualPerceptionResult;
  /** True when the active page is a browser-restricted surface (from M3). */
  restricted?: boolean;
}

export interface PolicyDecision {
  action: PolicyAction;
  severity: RiskSeverity;
  /** 0..1 confidence in the DECISION. NOT a detection-accuracy figure. */
  confidence: number;
  reasonCode: PolicyReasonCode;
  /** Distinct contributing signal categories, deduped and sorted. */
  signals: PolicySignalCategory[];
  /** Human-readable and non-sensitive: categories and counts only. */
  explanation: string;
  /** Always true: computed entirely on-device. */
  local: true;
}

// ---------------------------------------------------------------------------
// M4 — per-finding (multi-region) output.
//
// `decidePolicy` returns one page-level `PolicyDecision`. `decidePolicyReport`
// returns that same rollup PLUS a decision for EVERY applicable finding/region,
// so a later sanitization pass (M5) can act on each region individually. A
// finding decision carries only the location metadata M5 needs — a stable id,
// the perception source, an optional DOM element handle, and an optional
// bounding box — NEVER the raw value (`SensitiveEntity.text`), pixels, or a
// screenshot.
// ---------------------------------------------------------------------------

/**
 * Location/metadata for one finding, preserved for downstream sanitization.
 * Carries no raw content: `bbox` is geometry, `elementId` is a DOM handle,
 * `findingId` is the upstream detector's id.
 */
export interface PolicyRegionRef {
  /** Where the finding originated (DOM text, OCR, vision, or fused). */
  source: PerceptionSource;
  /** Stable id from the upstream finding (entity id or visual region id). */
  findingId?: string;
  /** DOM element handle from the collector, when the finding is DOM-based. */
  elementId?: string;
  /** Bounding box in CSS px, normalized to [x, y, width, height], when known. */
  bbox?: [number, number, number, number];
}

/**
 * A decision for a single finding/region. Same action vocabulary as
 * `PolicyDecision`, scoped to one region and carrying its `ref` so M5 knows
 * WHERE to act. Never carries the raw value.
 */
export interface FindingDecision {
  ref: PolicyRegionRef;
  action: PolicyAction;
  severity: RiskSeverity;
  reasonCode: PolicyReasonCode;
  signal: PolicySignalCategory;
  /** 0..1 confidence in THIS finding's decision. */
  confidence: number;
}

/**
 * The full multi-finding policy result: a page-level rollup (`overall`) plus a
 * deterministic, deduped, per-finding decision list covering ALL applicable
 * findings/regions on the page. `findings` is empty when nothing sensitive or
 * uncertain was found, or when the decision is a whole-input fail-safe
 * (malformed input / no signals available).
 */
export interface PolicyReport {
  overall: PolicyDecision;
  findings: FindingDecision[];
  /** M7.5 — the page-type classification that informed this report, when present. */
  visualContext?: PageClassification;
}

export interface AliasRecord {
  /** e.g. USER_EMAIL_1 */
  alias: string;
  category: SensitiveCategory;
  sessionId: string;
  createdAt: number;
  // actualValue MUST remain local (stored in the vault, never serialized remotely).
}

export type AgentAction =
  | { action: 'CLICK'; target: string }
  | { action: 'TYPE'; target: string; value: string }
  | { action: 'SELECT'; target: string; value: string }
  | { action: 'SCROLL'; amount: number }
  | { action: 'NAVIGATE'; url: string };

export type AgentActionKind = AgentAction['action'];

export type PrivacyEventType =
  'DETECTED' | 'SANITIZED' | 'BLOCKED' | 'ALIAS_RESOLVED' | 'TASK_RESULT';

export interface PrivacyEvent {
  type: PrivacyEventType;
  entityCategory?: SensitiveCategory;
  alias?: string;
  timestamp: number;
  // never store the raw protected value
}

/**
 * Sanitized request that may cross the remote boundary.
 * See docs/threat-model.md §5 (allowlist) and §6 (denylist).
 */
export interface RemoteAgentRequest {
  taskObjective: string;
  /** Current page origin ONLY (never the full URL — path/query can carry content). */
  pageOrigin?: string;
  sanitizedPageStructure: SanitizedNode[];
  sanitizedVisibleText: string;
  aliases: { alias: string; category: SensitiveCategory }[];
  availableActions: AgentActionKind[];
  policy: { privacyMode: string; navigationAllowlist: string[] };
}

// ---------------------------------------------------------------------------
// M6 — Agent, structured actions, and the sanitized page snapshot.
//
// The agent loop observes the page ONLY through sanitized structures: a
// `SanitizedNode` carries field semantics (tag/type/label/name) and whether a
// field is filled — never a raw value. Labels/names are included only when the
// local PII detector finds nothing in them (fail closed); the privacy firewall
// re-scans the whole serialized request before any transmission.
// ---------------------------------------------------------------------------

/** One form/control on the page, as seen by the REMOTE planner. Never a raw value. */
export interface SanitizedNode {
  tag: 'input' | 'textarea' | 'select' | 'button';
  /** Deterministic CSS selector computed by the content script; the ONLY way to target it. */
  selector: string;
  /** For inputs/selects: the declared type (`text`, `email`, `password`, …). */
  inputType?: string;
  /** Accessible label text; present ONLY when detection found nothing sensitive in it. */
  label?: string;
  /** Field name attribute; gated exactly like `label`. */
  name?: string;
  /** True when the field currently holds a value (the value itself never crosses). */
  filled: boolean;
  disabled: boolean;
  /**
   * True when the control sits below the current viewport fold at scan time. Geometry
   * is not content (coordinates are non-sensitive), and it lets a planner emit a
   * bounded SCROLL before interacting — recomputed every observation, so the page
   * state after scrolling is still the loop's only memory.
   */
  belowFold?: boolean;
}

// ---------------------------------------------------------------------------
// M5 — Sanitization / privacy enforcement output.
//
// M5 consumes the M4 `PolicyReport` (the per-finding decisions) plus the raw
// `SensitiveEntity[]` that produced them, and neutralises every applicable
// finding BEFORE any content can be placed on a `RemoteAgentRequest`:
//   - text findings   → the raw value is replaced by a stable semantic alias
//                        (`USER_EMAIL_1`); the alias↔value mapping is stored in
//                        the LOCAL vault only.
//   - visual findings → the region is emitted as a mask directive (geometry
//                        only) and can be obscured in any LOCAL pixel buffer.
//
// PRIVACY: an `EnforcementResult` carries aliases (type only), geometry, and
// per-finding dispositions — NEVER a raw value, pixels, or a screenshot. The raw
// value lives solely in the vault (local, in memory). No finding is ever dropped.
// ---------------------------------------------------------------------------

/** Alias directory entry safe to cross the remote boundary: a type, never a value. */
export interface AliasBinding {
  alias: string;
  category: SensitiveCategory;
}

/** What M5 did with a single M4 finding. Every finding gets exactly one. */
export type FindingDisposition =
  | 'aliased' // raw text value replaced by a semantic alias (stored in the vault)
  | 'masked' // visual region scheduled for pixel masking (geometry preserved)
  | 'flagged' // malformed/unparseable finding kept for caution; not neutralisable
  | 'inaccessible'; // finding references content M5 cannot resolve or reach; fail closed

/**
 * A region to obscure in a LOCAL visual buffer, in CSS px [x, y, width, height].
 * Overlapping findings are merged into one directive whose bbox is their union,
 * so the protected area is never smaller than the sum of the sensitive regions.
 */
export interface VisualMaskDirective {
  bbox: [number, number, number, number];
  /** Upstream finding ids this directive covers — none is ever silently dropped. */
  findingIds: string[];
  source: PerceptionSource;
}

/** Per-finding record of the enforcement action. Carries no raw value. */
export interface FindingEnforcement {
  ref: PolicyRegionRef;
  action: PolicyAction;
  severity: RiskSeverity;
  disposition: FindingDisposition;
  /** Set only when `disposition === 'aliased'`; the alias, never the raw value. */
  alias?: string;
}

/**
 * The result of one enforcement pass. Everything here is safe to inspect and
 * hand toward the remote boundary — it contains aliases, geometry, and
 * dispositions only. The caller MUST fail closed and refuse to send whenever
 * `blocked`, `restricted`, or `!enforced` (CONTRIBUTING.md §5 Rule 7): the firewall
 * (M7) remains the final boundary.
 */
export interface EnforcementResult {
  /**
   * Visible text with every recoverable raw value replaced by its alias. Empty
   * unless the page is fully safe (`enforced && !blocked && !restricted`): when
   * M5 cannot certify the page it withholds cleartext rather than risk emitting
   * an unidentified raw value (CONTRIBUTING.md §5 Rule 7 — fail closed).
   */
  sanitizedText: string;
  /** Alias directory for the remote request — types only, never values. */
  aliases: AliasBinding[];
  /** Deterministic, overlap-merged visual mask directives (geometry only). */
  visualMasks: VisualMaskDirective[];
  /** One entry per M4 finding — none is ever silently dropped. */
  findings: FindingEnforcement[];
  /** A page-level BLOCK (e.g. critical credential) was present. */
  blocked: boolean;
  /** The surface is browser-restricted and could not be fully inspected. */
  restricted: boolean;
  /** True only if every finding was neutralised AND the page is not uncertain. */
  enforced: boolean;
  /** Always true: computed entirely on-device. */
  local: true;
}
