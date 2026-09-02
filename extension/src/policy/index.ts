// M4 — Local privacy decision / policy layer.
//
// A pure, synchronous reducer over the signals M0–M3 already produced. It does
// NOT detect, capture, OCR, run a model, perform I/O, or log. Given
// `PolicySignals` it returns a deterministic decision.
//
// Two entry points, same core:
//   - `decidePolicy`        → one page-level `PolicyDecision` (the rollup).
//   - `decidePolicyReport`  → the rollup PLUS a per-finding `FindingDecision`
//                             for every applicable finding/region, so a later
//                             sanitization pass (M5) can act on each region.
//
// Design rules (CONTRIBUTING.md §5, §16, §22):
//   - Fail closed. A missing, unavailable, or malformed signal never yields
//     ALLOW. Absence of evidence is not evidence of safety.
//   - No raw values escape. Decisions are built from category tags, counts, and
//     location metadata (bbox / element handle / id) only; `SensitiveEntity.text`
//     is never read, so it can never leak into an explanation, a finding, a
//     signals list, or a log line (there are no log lines).
//   - Deterministic. Same input → same output, independent of finding order. No
//     clocks, no randomness.
//
// This module deliberately holds NO reference to pixels, rasters, screenshots,
// or the visual capture — it only reads M3's derived, non-reversible labels and
// geometry.

import type {
  FindingDecision,
  PerceptionSource,
  PolicyAction,
  PolicyDecision,
  PolicyReasonCode,
  PolicyRegionRef,
  PolicyReport,
  PolicySignalCategory,
  PolicySignals,
  RiskSeverity,
} from '../types/contracts';

// ---------------------------------------------------------------------------
// Tunable thresholds. Exported so tests reference them instead of magic values.
// ---------------------------------------------------------------------------

/** At/above this confidence a detection is treated as CONFIRMED. */
export const CONFIRMED_CONFIDENCE = 0.85;
/** Below CONFIRMED but at/above this: POSSIBLE. Below this: still POSSIBLE
 *  (a weak hit is never discarded), but flagged low-confidence. */
export const POSSIBLE_CONFIDENCE = 0.5;
/** A visual `text_like_content` observation at/above this confidence is treated
 *  as "there is unread rendered text here" → uncertainty, not clearance. */
export const VISUAL_TEXT_LIKE_CONFIDENCE = 0.6;

/** Decision-confidence constants (confidence in the CALL, not in detection). */
export const ALLOW_DECISION_CONFIDENCE = 0.9;
export const RESTRICTED_DECISION_CONFIDENCE = 0.5;
export const UNAVAILABLE_DECISION_CONFIDENCE = 0.3;
export const MALFORMED_DECISION_CONFIDENCE = 0.3;

// ---------------------------------------------------------------------------
// Category → risk classification.
//
// Tolerant of BOTH the declared `SensitiveCategory` union AND the strings the
// M2 PII detector actually emits (PHONE_NUMBER, PAYMENT_CARD, CREDENTIAL), which
// differ from the declared names. Unknown strings map conservatively to
// `medium`/`dom_pii` — never to `none`. `UNCLASSIFIED` (the DOM collector's
// default tag for ordinary visible text) is explicitly benign: it means "we saw
// text", not "we saw something sensitive".
// ---------------------------------------------------------------------------

interface CategoryClass {
  severity: RiskSeverity;
  signal: PolicySignalCategory;
}

export const CATEGORY_TABLE: Readonly<Record<string, CategoryClass>> = {
  PASSWORD: { severity: 'critical', signal: 'credential' },
  CREDENTIAL: { severity: 'critical', signal: 'credential' },
  OTP: { severity: 'critical', signal: 'credential' },
  PAYMENT: { severity: 'high', signal: 'payment' },
  PAYMENT_CARD: { severity: 'high', signal: 'payment' },
  ID: { severity: 'high', signal: 'identity' },
  ADDRESS: { severity: 'medium', signal: 'contact' },
  PHONE: { severity: 'medium', signal: 'contact' },
  PHONE_NUMBER: { severity: 'medium', signal: 'contact' },
  EMAIL: { severity: 'medium', signal: 'contact' },
  NAME: { severity: 'low', signal: 'personal' },
  CUSTOM: { severity: 'low', signal: 'personal' },
  // DOM collector's default for ordinary visible text — not a sensitivity hit.
  UNCLASSIFIED: { severity: 'none', signal: 'dom_pii' },
};

/** Unknown / unrecognized category string: conservative, never safe. */
const UNKNOWN_CATEGORY: CategoryClass = { severity: 'medium', signal: 'dom_pii' };

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const ACTION_PRECEDENCE: Readonly<Record<PolicyAction, number>> = {
  ALLOW: 0,
  WARN: 1,
  SANITIZE: 2,
  BLOCK: 3,
};

const PERCEPTION_SOURCES: readonly PerceptionSource[] = ['DOM', 'OCR', 'VISION', 'FUSED'];

// ---------------------------------------------------------------------------
// Small runtime guards. The engine accepts untrusted upstream data, so every
// field is validated at runtime regardless of its declared type.
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize a bounding box to a `[x, y, width, height]` tuple. Accepts either
 *  the declared tuple form OR the `{x,y,width,height}` object the DOM collector
 *  emits (a known M2/M3 shape drift). Returns undefined if geometry is absent or
 *  not fully numeric — coordinates are never fabricated. */
function normalizeBbox(raw: unknown): [number, number, number, number] | undefined {
  if (Array.isArray(raw) && raw.length === 4) {
    const nums = raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    if (nums.length === 4) return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
    return undefined;
  }
  const rec = asRecord(raw);
  if (rec) {
    const { x, y, width, height } = rec;
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      [x, y, width, height].every((n) => Number.isFinite(n))
    ) {
      return [x, y, width, height];
    }
  }
  return undefined;
}

/** Map any perception-source string (case-insensitive; e.g. M3's lowercase
 *  'vision'/'ocr') to the declared `PerceptionSource`, else undefined. */
function normalizeSource(raw: unknown): PerceptionSource | undefined {
  if (typeof raw !== 'string') return undefined;
  const up = raw.toUpperCase();
  return (PERCEPTION_SOURCES as readonly string[]).includes(up)
    ? (up as PerceptionSource)
    : undefined;
}

// ---------------------------------------------------------------------------
// Internal contribution model. Each signal produces zero or more contributions;
// the page-level decision is the highest-precedence one, and each contribution
// that carries a `ref` also becomes a per-finding decision.
// ---------------------------------------------------------------------------

type ConfidenceBand = 'confirmed' | 'possible';

interface Contribution {
  action: PolicyAction;
  reasonCode: PolicyReasonCode;
  severity: RiskSeverity;
  signal: PolicySignalCategory;
  band: ConfidenceBand;
  /** 0..1 — used for tie-breaking and as the decision confidence when this wins. */
  confidence: number;
  /** Present ⇒ this contribution corresponds to a concrete finding/region and
   *  is surfaced in `PolicyReport.findings`. Absent ⇒ page-level only
   *  (restricted surface, whole-input malformed shape). */
  ref?: PolicyRegionRef;
}

/**
 * Map a (severity, band) pair to the action/reason it warrants.
 *   critical+confirmed → BLOCK      critical+possible → SANITIZE
 *   high|medium+confirmed → SANITIZE high|medium+possible → WARN
 *   low → WARN                       none → ALLOW
 */
function actionFor(
  severity: RiskSeverity,
  band: ConfidenceBand,
): { action: PolicyAction; reasonCode: PolicyReasonCode } {
  if (severity === 'critical') {
    return band === 'confirmed'
      ? { action: 'BLOCK', reasonCode: 'CRITICAL_CREDENTIAL' }
      : { action: 'SANITIZE', reasonCode: 'POSSIBLE_SENSITIVE_DATA' };
  }
  if (severity === 'high' || severity === 'medium') {
    return band === 'confirmed'
      ? { action: 'SANITIZE', reasonCode: 'CONFIRMED_SENSITIVE_DATA' }
      : { action: 'WARN', reasonCode: 'POSSIBLE_SENSITIVE_DATA' };
  }
  if (severity === 'low') {
    return { action: 'WARN', reasonCode: 'POSSIBLE_SENSITIVE_DATA' };
  }
  return { action: 'ALLOW', reasonCode: 'NO_SENSITIVE_DATA' };
}

/** Build a non-sensitive location ref from an entity-shaped record. Salvages
 *  only trusted, non-content fields; never reads `text`. */
function refFromEntity(rec: Record<string, unknown>): PolicyRegionRef {
  const ref: PolicyRegionRef = { source: normalizeSource(rec.source) ?? 'DOM' };
  if (typeof rec.id === 'string' && rec.id.length > 0) ref.findingId = rec.id;
  if (typeof rec.elementId === 'string' && rec.elementId.length > 0) ref.elementId = rec.elementId;
  const bbox = normalizeBbox(rec.bbox);
  if (bbox) ref.bbox = bbox;
  return ref;
}

const MALFORMED_BASE = {
  action: 'WARN',
  reasonCode: 'MALFORMED_SIGNAL',
  severity: 'medium',
  signal: 'dom_pii',
  band: 'possible',
  confidence: MALFORMED_DECISION_CONFIDENCE,
} as const satisfies Omit<Contribution, 'ref'>;

/** A shape-level malformed contribution (no finding to point at). */
const MALFORMED_CONTRIBUTION: Contribution = { ...MALFORMED_BASE };

/** A malformed entity is still a finding: fail closed and keep whatever
 *  location we can trust, rather than silently dropping it (which would read as
 *  "safe"). */
function malformedEntityContribution(raw: unknown): Contribution {
  const rec = asRecord(raw);
  return { ...MALFORMED_BASE, ref: rec ? refFromEntity(rec) : { source: 'DOM' } };
}

/**
 * Classify one entity-shaped value.
 *   - returns a Contribution (with a `ref`) when it is a sensitive hit,
 *   - returns null when it ran but is benign (e.g. UNCLASSIFIED text),
 *   - returns 'malformed' when the value is not a usable entity.
 */
function classifyEntity(raw: unknown): Contribution | null | 'malformed' {
  const rec = asRecord(raw);
  if (!rec) return 'malformed';

  const category = rec.category;
  if (typeof category !== 'string' || category.length === 0) return 'malformed';

  const confidence = rec.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return 'malformed';

  const cls = CATEGORY_TABLE[category.toUpperCase()] ?? UNKNOWN_CATEGORY;
  if (cls.severity === 'none') return null; // ran, not sensitive

  const band: ConfidenceBand = confidence >= CONFIRMED_CONFIDENCE ? 'confirmed' : 'possible';
  const { action, reasonCode } = actionFor(cls.severity, band);
  return {
    action,
    reasonCode,
    severity: cls.severity,
    signal: cls.signal,
    band,
    confidence: clamp01(confidence),
    ref: refFromEntity(rec),
  };
}

/**
 * Inspect an M3 `VisualPerceptionResult`. Returns one contribution per confident
 * `text_like_content` region (each carrying that region's geometry), plus
 * whether the visual layer reported a restricted page. A visual region
 * contributes UNCERTAINTY, never a sensitivity verdict (M3 reads no text).
 * `not_required` / `unavailable` / `running` contribute nothing, so an ordinary
 * DOM-first page is never dragged to WARN by the visual layer.
 */
function inspectVisual(raw: unknown): {
  contributions: Contribution[];
  extraSignals: PolicySignalCategory[];
  restrictedFromVisual: boolean;
} {
  const rec = asRecord(raw);
  if (!rec) return { contributions: [], extraSignals: [], restrictedFromVisual: false };

  const status = rec.status;
  if (status === 'restricted_page') {
    return { contributions: [], extraSignals: [], restrictedFromVisual: true };
  }
  if (status !== 'completed') {
    return { contributions: [], extraSignals: [], restrictedFromVisual: false };
  }

  const observations = Array.isArray(rec.observations) ? rec.observations : [];
  const contributions: Contribution[] = [];
  for (const obs of observations) {
    const orec = asRecord(obs);
    if (!orec) continue;
    const labels = Array.isArray(orec.observations) ? orec.observations : [];
    const conf = typeof orec.confidence === 'number' ? orec.confidence : 0;
    if (!labels.includes('text_like_content') || conf < VISUAL_TEXT_LIKE_CONFIDENCE) continue;

    const region = asRecord(orec.region);
    const ref: PolicyRegionRef = { source: normalizeSource(orec.source) ?? 'VISION' };
    if (region) {
      if (typeof region.id === 'string' && region.id.length > 0) ref.findingId = region.id;
      const bbox = normalizeBbox(region);
      if (bbox) ref.bbox = bbox;
    }
    contributions.push({
      action: 'WARN',
      reasonCode: 'VISUAL_UNCERTAINTY',
      severity: 'low',
      signal: 'visual_uncertain',
      band: 'possible',
      confidence: clamp01(conf),
      ref,
    });
  }

  // Genuine OCR/vision content findings (categorized). Unlike the coarse
  // `text_like_content` uncertainty above, each asserts a category, so it is
  // classified with the SAME table as DOM/PII entities and drives a real masking
  // action. Absent/empty when no engine ran (honest `not_available`).
  const findings = Array.isArray(rec.contentFindings) ? rec.contentFindings : [];
  for (const raw of findings) {
    const c = classifyVisualFinding(raw);
    if (c) contributions.push(c);
  }

  return {
    contributions,
    extraSignals: contributions.length > 0 ? ['visual_text_like'] : [],
    restrictedFromVisual: false,
  };
}

/**
 * Classify one genuine visual content finding (category + geometry). Returns a
 * Contribution carrying the region's bbox + id, or null when the finding is
 * malformed or benign. Never reads `text` (raw recognized content stays local).
 */
function classifyVisualFinding(raw: unknown): Contribution | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  const category = rec.category;
  if (typeof category !== 'string' || category.length === 0) return null;

  const confidence = typeof rec.confidence === 'number' ? rec.confidence : 0;
  const cls = CATEGORY_TABLE[category.toUpperCase()] ?? UNKNOWN_CATEGORY;
  if (cls.severity === 'none') return null;

  const band: ConfidenceBand = confidence >= CONFIRMED_CONFIDENCE ? 'confirmed' : 'possible';
  const { action, reasonCode } = actionFor(cls.severity, band);

  const ref: PolicyRegionRef = { source: normalizeSource(rec.source) ?? 'VISION' };
  const bbox = normalizeBbox(rec.bbox);
  if (bbox) ref.bbox = bbox;
  // A single region can yield several INDEPENDENT findings (e.g. an email and a
  // phone painted in one image). Compose the finding id from region + geometry so
  // distinct sub-boxes are preserved as distinct findings, while true duplicates
  // (same region + same box) still collapse.
  if (typeof rec.regionId === 'string' && rec.regionId.length > 0) {
    ref.findingId = bbox ? `${rec.regionId}#${bbox.join(',')}` : rec.regionId;
  }

  return {
    action,
    reasonCode,
    severity: cls.severity,
    signal: cls.signal,
    band,
    confidence: clamp01(confidence),
    ref,
  };
}

/** Pick the contribution with the highest action precedence; ties → higher
 *  severity, then higher confidence. Order-independent and deterministic. */
function selectDominant(contributions: Contribution[]): Contribution {
  let best = contributions[0]!;
  for (let i = 1; i < contributions.length; i++) {
    const c = contributions[i]!;
    const dp = ACTION_PRECEDENCE[c.action] - ACTION_PRECEDENCE[best.action];
    if (dp > 0) {
      best = c;
      continue;
    }
    if (dp < 0) continue;
    const ds = SEVERITY_RANK[c.severity] - SEVERITY_RANK[best.severity];
    if (ds > 0 || (ds === 0 && c.confidence > best.confidence)) best = c;
  }
  return best;
}

function sortedUniqueSignals(signals: PolicySignalCategory[]): PolicySignalCategory[] {
  return Array.from(new Set(signals)).sort();
}

/** Non-sensitive summary: "1 confirmed credential, 2 possible contact". Uses
 *  category names and counts only — never any entity value. */
function summarizeContributions(contributions: Contribution[]): string {
  const counts = new Map<string, number>();
  for (const c of contributions) {
    const key = `${c.band} ${c.signal}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, n]) => `${n} ${key}`)
    .join(', ');
}

const REASON_SENTENCE: Readonly<Record<PolicyReasonCode, string>> = {
  NO_SENSITIVE_DATA: 'No sensitive signals were found after inspection.',
  POSSIBLE_SENSITIVE_DATA: 'Possible sensitive information was detected.',
  CONFIRMED_SENSITIVE_DATA: 'Sensitive information was detected with high confidence.',
  CRITICAL_CREDENTIAL: 'A credential or authentication secret was detected.',
  VISUAL_UNCERTAINTY: 'Rendered text-like content could not be read; treated as uncertain.',
  RESTRICTED_CONTEXT: 'The page is a browser-restricted surface and cannot be fully inspected.',
  SIGNAL_UNAVAILABLE: 'No signals were available to evaluate; defaulting to caution.',
  MALFORMED_SIGNAL: 'A signal could not be parsed; defaulting to caution.',
};

function decision(
  action: PolicyAction,
  severity: RiskSeverity,
  confidence: number,
  reasonCode: PolicyReasonCode,
  signals: PolicySignalCategory[],
  detail: string,
): PolicyDecision {
  const base = REASON_SENTENCE[reasonCode];
  const explanation = detail ? `${base} (${detail})` : base;
  return {
    action,
    severity,
    confidence: clamp01(confidence),
    reasonCode,
    signals: sortedUniqueSignals(signals),
    explanation,
    local: true,
  };
}

// ---------------------------------------------------------------------------
// Per-finding derivation: dedupe, conflict-resolve, and deterministically sort.
// ---------------------------------------------------------------------------

function contributionToFinding(c: Contribution & { ref: PolicyRegionRef }): FindingDecision {
  return {
    ref: c.ref,
    action: c.action,
    severity: c.severity,
    reasonCode: c.reasonCode,
    signal: c.signal,
    confidence: c.confidence,
  };
}

/** Stable identity key. Findings that share an upstream id are the same finding
 *  (conflicts on it resolve to the stronger action); otherwise identity is the
 *  origin + element + geometry + signal, so exact duplicates collapse while
 *  distinct (even overlapping) regions are preserved. */
function findingKey(f: FindingDecision): string {
  const r = f.ref;
  if (r.findingId) return `id:${r.findingId}`;
  const bbox = r.bbox ? r.bbox.join(',') : '';
  return `loc:${r.source}|${r.elementId ?? ''}|${bbox}|${f.signal}`;
}

function stronger(a: FindingDecision, b: FindingDecision): FindingDecision {
  const dp = ACTION_PRECEDENCE[b.action] - ACTION_PRECEDENCE[a.action];
  if (dp > 0) return b;
  if (dp < 0) return a;
  const ds = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (ds > 0) return b;
  if (ds < 0) return a;
  return b.confidence > a.confidence ? b : a;
}

function dedupeAndSortFindings(findings: FindingDecision[]): FindingDecision[] {
  const map = new Map<string, FindingDecision>();
  for (const f of findings) {
    const k = findingKey(f);
    const prev = map.get(k);
    map.set(k, prev ? stronger(prev, f) : f);
  }
  return Array.from(map.values()).sort((a, b) => {
    const dp = ACTION_PRECEDENCE[b.action] - ACTION_PRECEDENCE[a.action];
    if (dp !== 0) return dp;
    const ds = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (ds !== 0) return ds;
    const ka = findingKey(a);
    const kb = findingKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

/**
 * Decide how the extension should treat the current context AND return a
 * per-finding decision for every applicable finding/region. Pure and
 * synchronous; safe to call on every page because it performs no work of its
 * own beyond reducing the signals it is handed.
 */
export function decidePolicyReport(signals: PolicySignals): PolicyReport {
  const root = asRecord(signals);
  if (!root) {
    // Whole input is missing/garbage → fail closed, no findings to enumerate.
    return {
      overall: decision(
        'WARN',
        'medium',
        MALFORMED_DECISION_CONFIDENCE,
        'MALFORMED_SIGNAL',
        [],
        'signal object was missing or not an object',
      ),
      findings: [],
    };
  }

  const contributions: Contribution[] = [];
  const extraSignals: PolicySignalCategory[] = [];

  // --- Entities (M1/M2; any perception source) ----------------------------
  const rawEntities = root.entities;
  let entitiesRan = false;
  if (Array.isArray(rawEntities)) {
    entitiesRan = true;
    for (const e of rawEntities) {
      const c = classifyEntity(e);
      if (c === 'malformed') contributions.push(malformedEntityContribution(e));
      else if (c) contributions.push(c);
    }
  } else if (rawEntities !== undefined) {
    // Present but not an array → malformed shape (no finding to point at).
    contributions.push(MALFORMED_CONTRIBUTION);
  }

  // --- Visual (M3) --------------------------------------------------------
  const visual = inspectVisual(root.visual);
  contributions.push(...visual.contributions);
  extraSignals.push(...visual.extraSignals);

  // --- Restricted page (page-level; not a region) -------------------------
  const restricted = root.restricted === true || visual.restrictedFromVisual;
  if (restricted) {
    contributions.push({
      action: 'WARN',
      reasonCode: 'RESTRICTED_CONTEXT',
      severity: 'low',
      signal: 'restricted_page',
      band: 'possible',
      confidence: RESTRICTED_DECISION_CONFIDENCE,
    });
  }

  // --- No contributions: either ALLOW (ran, clean) or fail-safe WARN ------
  if (contributions.length === 0) {
    if (entitiesRan) {
      return {
        overall: decision(
          'ALLOW',
          'none',
          ALLOW_DECISION_CONFIDENCE,
          'NO_SENSITIVE_DATA',
          [],
          'entities analysed, none classified sensitive',
        ),
        findings: [],
      };
    }
    // Nothing ran that we can trust → never assume safe.
    return {
      overall: decision(
        'WARN',
        'low',
        UNAVAILABLE_DECISION_CONFIDENCE,
        'SIGNAL_UNAVAILABLE',
        [],
        'no entity, visual, or restriction signal was provided',
      ),
      findings: [],
    };
  }

  // --- Reduce to the dominant contribution (page-level rollup) ------------
  const dominant = selectDominant(contributions);
  const maxSeverity = contributions.reduce<RiskSeverity>((acc, c) => {
    return SEVERITY_RANK[c.severity] > SEVERITY_RANK[acc] ? c.severity : acc;
  }, 'none');

  const allSignals = contributions.map((c) => c.signal).concat(extraSignals);
  const detail = summarizeContributions(contributions);

  const overall = decision(
    dominant.action,
    maxSeverity,
    dominant.confidence,
    dominant.reasonCode,
    allSignals,
    detail,
  );

  // --- Per-finding decisions (only contributions tied to a region) --------
  const findingContributions = contributions.filter(
    (c): c is Contribution & { ref: PolicyRegionRef } => c.ref !== undefined,
  );
  const findings = dedupeAndSortFindings(findingContributions.map(contributionToFinding));

  return { overall, findings };
}

/**
 * Page-level decision only — the `overall` rollup from `decidePolicyReport`.
 * Retained as the primary entry point for callers that need a single verdict.
 */
export function decidePolicy(signals: PolicySignals): PolicyDecision {
  return decidePolicyReport(signals).overall;
}
