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
