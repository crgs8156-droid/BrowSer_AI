// M4 — Local privacy decision / policy layer.
//
// A pure, synchronous reducer over the signals M0–M3 already produced. It does
// NOT detect, capture, OCR, run a model, perform I/O, or log. Given
// `PolicySignals` it returns one deterministic `PolicyDecision`.
//
// Design rules (CLAUDE.md §5, §16, §22):
//   - Fail closed. A missing, unavailable, or malformed signal never yields
//     ALLOW. Absence of evidence is not evidence of safety.
//   - No raw values escape. The decision is built from category tags and counts
//     only; `SensitiveEntity.text` is never read, so it can never leak into the
//     explanation, the signals list, or a log line (there are no log lines).
//   - Deterministic. Same input → same output. No clocks, no randomness.
//
// This module deliberately holds NO reference to pixels, rasters, screenshots,
// or the visual capture — it only reads M3's derived, non-reversible labels.

import type {
  PolicyAction,
  PolicyDecision,
  PolicyReasonCode,
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

// ---------------------------------------------------------------------------
// Internal contribution model. Each signal produces zero or more contributions;
// the decision is the highest-precedence one.
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
}

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

const MALFORMED_CONTRIBUTION: Contribution = {
  action: 'WARN',
  reasonCode: 'MALFORMED_SIGNAL',
  severity: 'medium',
  signal: 'dom_pii',
  band: 'possible',
  confidence: MALFORMED_DECISION_CONFIDENCE,
};

/**
 * Classify one entity-shaped value.
 *   - returns a Contribution when it is a sensitive hit,
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
  };
}

/**
 * Inspect an M3 `VisualPerceptionResult`. Returns any visual contributions plus
 * whether the visual layer reported a restricted page. Only a COMPLETED result
 * carrying a confident `text_like_content` observation contributes — and it
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
  let maxTextLikeConfidence = -1;
  for (const obs of observations) {
    const orec = asRecord(obs);
    if (!orec) continue;
    const labels = Array.isArray(orec.observations) ? orec.observations : [];
    const conf = typeof orec.confidence === 'number' ? orec.confidence : 0;
    if (labels.includes('text_like_content') && conf >= VISUAL_TEXT_LIKE_CONFIDENCE) {
      if (conf > maxTextLikeConfidence) maxTextLikeConfidence = conf;
    }
  }

  if (maxTextLikeConfidence < 0) {
    return { contributions: [], extraSignals: [], restrictedFromVisual: false };
  }

  return {
    contributions: [
      {
        action: 'WARN',
        reasonCode: 'VISUAL_UNCERTAINTY',
        severity: 'low',
        signal: 'visual_uncertain',
        band: 'possible',
        confidence: clamp01(maxTextLikeConfidence),
      },
    ],
    extraSignals: ['visual_text_like'],
    restrictedFromVisual: false,
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
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Decide how the extension should treat the current context, given the signals
 * M0–M3 produced. Pure and synchronous; safe to call on every page because it
 * performs no work of its own beyond reducing the signals it is handed.
 */
export function decidePolicy(signals: PolicySignals): PolicyDecision {
  const root = asRecord(signals);
  if (!root) {
    // Whole input is missing/garbage → fail closed.
    return decision(
      'WARN',
      'medium',
      MALFORMED_DECISION_CONFIDENCE,
      'MALFORMED_SIGNAL',
      [],
      'signal object was missing or not an object',
    );
  }

  const contributions: Contribution[] = [];
  const extraSignals: PolicySignalCategory[] = [];

  // --- Entities (M1/M2) ---------------------------------------------------
  const rawEntities = root.entities;
  let entitiesRan = false;
  if (Array.isArray(rawEntities)) {
    entitiesRan = true;
    for (const e of rawEntities) {
      const c = classifyEntity(e);
      if (c === 'malformed') contributions.push(MALFORMED_CONTRIBUTION);
      else if (c) contributions.push(c);
    }
  } else if (rawEntities !== undefined) {
    // Present but not an array → malformed shape.
    contributions.push(MALFORMED_CONTRIBUTION);
  }

  // --- Visual (M3) --------------------------------------------------------
  const visual = inspectVisual(root.visual);
  contributions.push(...visual.contributions);
  extraSignals.push(...visual.extraSignals);

  // --- Restricted page ----------------------------------------------------
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
      return decision(
        'ALLOW',
        'none',
        ALLOW_DECISION_CONFIDENCE,
        'NO_SENSITIVE_DATA',
        [],
        'entities analysed, none classified sensitive',
      );
    }
    // Nothing ran that we can trust → never assume safe.
    return decision(
      'WARN',
      'low',
      UNAVAILABLE_DECISION_CONFIDENCE,
      'SIGNAL_UNAVAILABLE',
      [],
      'no entity, visual, or restriction signal was provided',
    );
  }

  // --- Reduce to the dominant contribution --------------------------------
  const dominant = selectDominant(contributions);
  const maxSeverity = contributions.reduce<RiskSeverity>((acc, c) => {
    return SEVERITY_RANK[c.severity] > SEVERITY_RANK[acc] ? c.severity : acc;
  }, 'none');

  const allSignals = contributions.map((c) => c.signal).concat(extraSignals);
  const detail = summarizeContributions(contributions);

  return decision(
    dominant.action,
    maxSeverity,
    dominant.confidence,
    dominant.reasonCode,
    allSignals,
    detail,
  );
}
