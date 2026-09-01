// Derives the concise, display-safe summary the side panel renders from an M5
// `EnforcementResult`. This is a PURE function: no I/O, no detection, no network.
//
// PRIVACY: the returned `ScanSummary` contains ONLY aliases (types, e.g. USER_EMAIL_1),
// non-content region ids/geometry, page-section indices, severities, and dispositions —
// never a raw value, page text, markup, pixels, or a screenshot. Everything here is
// already safe by construction because an `EnforcementResult` carries no raw value
// (raw values live solely in the local vault, reachable only via an alias).
//
// SCOPE (honest): a masked image/visual region carries a category ONLY when a real OCR/
// vision engine recognized one there. When no engine is registered (the default), regions
// are surfaced as MASKED REGIONS + page section, never a fabricated category (CONTRIBUTING.md §22).

import type {
  EnforcementResult,
  FindingDisposition,
  PerceptionSource,
  RiskSeverity,
  SensitiveCategory,
} from '../types/contracts';

export type ScanStatus = 'complete' | 'restricted';

export type ScanFindingKind = 'text' | 'image';

/** Ranking so deduplication can keep the strongest severity of merged rows. */
const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function strongerSeverity(a: RiskSeverity | undefined, b: RiskSeverity | undefined): RiskSeverity {
  const ra = SEVERITY_RANK[a ?? 'none'];
  const rb = SEVERITY_RANK[b ?? 'none'];
  return ra >= rb ? (a ?? 'none') : (b ?? 'none');
}

/** Human-readable category labels for text findings. */
const CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  NAME: 'Name',
  ADDRESS: 'Address',
  PASSWORD: 'Password / credential',
  OTP: 'One-time code',
  PAYMENT: 'Payment card',
  ID: 'Identity document',
  CUSTOM: 'Sensitive value',
};

/** One display row. Carries display metadata only — never a raw value. */
export interface ScanFindingView {
  kind: ScanFindingKind;
  /** Alias for text (USER_EMAIL_1…), a synthetic region id for image/unresolved. */
  displayId: string;
  /** Human label for the row. */
  label: string;
  /** Normalised category — text findings only (images are unclassified: no OCR). */
  category?: SensitiveCategory;
  /** Severity — text/unresolved findings only. Images carry no fabricated severity. */
  severity?: RiskSeverity;
  /** 1-based page section (bbox.y ÷ viewport height) — findings with geometry only. */
  section?: number;
  /** Region geometry in CSS px — image findings only. Geometry is not content. */
  geometry?: { width: number; height: number };
  /** Origin of the finding: DOM text, OCR text, visual region, or fused. */
  source?: PerceptionSource;
  /** Honest M5 disposition for this finding. */
  disposition: FindingDisposition;
}

export interface ScanSummary {
  status: ScanStatus;
  /** Total sensitive items surfaced (text + image + unresolved). Never truncated. */
  total: number;
  /** Count of text regions (aliased text values, incl. below-the-fold). */
  textCount: number;
  /** Count of image/visual regions (overlap-merged masked directives). */
  imageCount: number;
  /** All findings, most actionable first (text before image before unresolved). */
  findings: ScanFindingView[];
  /** A critical credential (or page-level BLOCK) was present — outbound is blocked. */
  blocked: boolean;
  /** The surface was browser-restricted / could not be fully inspected. */
  restricted: boolean;
  /** True only if every finding was neutralised AND the page is not uncertain. */
  enforced: boolean;
}

/** 1-based page section from a bounding box's top, relative to the viewport height. */
function sectionOf(y: number, viewportHeight?: number): number {
  if (viewportHeight === undefined || viewportHeight <= 0 || !Number.isFinite(y)) return 1;
  return Math.max(1, Math.floor(Math.max(0, y) / viewportHeight) + 1);
}

/**
 * Build the display summary from an enforcement result.
 *
 * @param result         the M5 `EnforcementResult` for the scanned page
 * @param viewportHeight the page viewport height (from the M3 snapshot), for sectioning
 */
export function buildScanSummary(
  result: EnforcementResult,
  viewportHeight?: number,
): ScanSummary {
  const aliasCategory = new Map<string, SensitiveCategory>(
    result.aliases.map((binding) => [binding.alias, binding.category]),
  );

  const findings: ScanFindingView[] = [];

  // 1. Text findings — the aliased dispositions (recoverable values, now in the vault).
  //    Includes below-the-fold text: detection runs over whole-page `innerText`.
  //
  //    DEDUPLICATION: one underlying value can be detected several times — e.g. an email
  //    that appears both in visible text AND in a form field's `.value` (both land in
  //    `pageText`), or the same value seen by DOM and OCR. Enforcement keeps every raw
  //    finding (so redaction/masking is complete), but the DISPLAY must show each unique
  //    value ONCE. The alias IS the dedup key: identical value+category ⇒ identical alias
  //    (see alias allocator), so collapsing by alias merges true duplicates while keeping
  //    genuinely distinct values (USER_EMAIL_1 vs USER_EMAIL_2) apart. Strongest severity
  //    and earliest source win the merged row.
  const textByAlias = new Map<string, ScanFindingView>();
  for (const finding of result.findings) {
    if (finding.disposition !== 'aliased' || finding.alias === undefined) continue;
    const category = aliasCategory.get(finding.alias) ?? 'CUSTOM';
    const existing = textByAlias.get(finding.alias);
    if (existing) {
      existing.severity = strongerSeverity(existing.severity, finding.severity);
      continue;
    }
    textByAlias.set(finding.alias, {
      kind: 'text',
      displayId: finding.alias,
      label: CATEGORY_LABELS[category],
      category,
      severity: finding.severity,
      source: finding.ref.source,
      disposition: 'aliased',
    });
  }
  for (const view of textByAlias.values()) findings.push(view);

  // 2. Image/visual findings — the deterministic, overlap-merged mask directives. A
  //    directive's source is honest about origin: OCR (text recognized in pixels), VISION
  //    (a categorized visual finding), or FUSED. `text_like_content` uncertainty regions
  //    (no category, no OCR) carry no category — surfaced as masked regions + section.
  //    Overlap-merging already deduplicates co-located regions upstream (mergeMaskRegions).
  result.visualMasks.forEach((mask, index) => {
    const isOcr = mask.source === 'OCR';
    findings.push({
      kind: 'image',
      displayId: isOcr ? `OCR_REGION_${index + 1}` : `IMAGE_REGION_${index + 1}`,
      label: isOcr ? 'OCR text region (masked)' : 'Image region (masked)',
      section: sectionOf(mask.bbox[1], viewportHeight),
      geometry: { width: Math.round(mask.bbox[2]), height: Math.round(mask.bbox[3]) },
      source: mask.source,
      disposition: 'masked',
    });
  });

  // 3. Unresolved findings — flagged (malformed) / inaccessible. Kept, never dropped:
  //    the pipeline could not neutralise them, so the user is told honestly.
  let unresolvedIndex = 0;
  for (const finding of result.findings) {
    if (finding.disposition !== 'flagged' && finding.disposition !== 'inaccessible') continue;
    unresolvedIndex += 1;
    const bbox = finding.ref.bbox;
    const hasBox = Array.isArray(bbox);
    findings.push({
      kind: hasBox ? 'image' : 'text',
      displayId: `UNRESOLVED_${unresolvedIndex}`,
      label:
        finding.disposition === 'flagged'
          ? 'Unresolved region (flagged)'
          : 'Unresolved region (inaccessible)',
      severity: finding.severity,
      section: hasBox ? sectionOf(bbox[1] ?? 0, viewportHeight) : undefined,
      disposition: finding.disposition,
    });
  }

  const textCount = findings.filter((finding) => finding.kind === 'text').length;
  const imageCount = findings.filter((finding) => finding.kind === 'image').length;

  return {
    status: result.restricted ? 'restricted' : 'complete',
    total: findings.length,
    textCount,
    imageCount,
    findings,
    blocked: result.blocked,
    restricted: result.restricted,
    enforced: result.enforced,
  };
}
