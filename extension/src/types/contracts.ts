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
  observations: VisualObservation[];
  metrics: VisualPerceptionMetrics;
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
  | 'restricted_page';

/**
 * Signals handed to the policy engine. Every field is optional; absence is
 * treated as "unknown", never as "safe" (CLAUDE.md §5 Rule 7 — fail closed).
 */
export interface PolicySignals {
  /** PII/DOM entities from M1/M2. `undefined` ⇒ detection did not run. */
  entities?: SensitiveEntity[];
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
  sanitizedPageStructure: unknown[];
  sanitizedVisibleText: string;
  aliases: { alias: string; category: SensitiveCategory }[];
  availableActions: AgentActionKind[];
  policy: { privacyMode: string; navigationAllowlist: string[] };
}
