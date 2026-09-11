// M7.5 — rule-based page-type classifier (blueprint §5: multi-signal, context-aware).
//
// Deliberately NOT a vision model: page type is a STRUCTURAL property of the DOM, and
// every signal it needs (field types, labels, page text) is already collected by the
// scan pipeline — zero extra perception cost, zero pixels read.
//
// TODO (upgrade path): a MobileViT-XXS ONNX classifier (~6MB) could classify page type
// from rendered pixels alone (useful for canvas-only pages), but it is an ImageNet
// architecture requiring a fine-tuning sprint on a labelled page-type corpus before it
// can claim any accuracy. Until that model exists and is benchmarked, this rule-based
// classifier is the honest, demonstrable implementation — it never fabricates a
// category its rules cannot support.

import type { FieldStructure } from '../../types/messages';
import type { PageClassification, VisualPageType } from '../../types/contracts';

const PAYMENT_LABELS = /card|cvv|expir/i;
const AUTH_LABELS = /password|login|log in|sign in|signin/i;
const MEDICAL_LABELS = /diagnosis|prescription|patient|dob|medical/i;

/** Confidence for explicit structural signals (e.g. a password field). */
const EXPLICIT_CONFIDENCE = 0.95;
/** Confidence for label/text keyword matches. */
const LABEL_CONFIDENCE = 0.75;
/** Confidence for weak structural signals (field count, default). */
const STRUCTURAL_CONFIDENCE = 0.6;

/** The minimum number of input fields for a page to look like a generic form. */
const FORM_FIELD_THRESHOLD = 3;

function isField(field: FieldStructure): boolean {
  return field.tag === 'input' || field.tag === 'textarea' || field.tag === 'select';
}

function fieldHaystack(field: FieldStructure): string {
  return `${field.label ?? ''} ${field.name ?? ''} ${field.inputType ?? ''}`;
}

// Phase 1B/1C — CAPTCHA + error-page detection.
//
// Honest signal limits (CONTRIBUTING.md §3): the scan pipeline exposes form-control
// fields (tag/label/name/inputType) + whole-page innerText only — iframe src, element
// class lists, img alt attributes, and h1/h2/title tags are NOT collected (see
// `FieldStructure`). Detection therefore runs on `pageText` + label/name haystacks:
// visible CAPTCHA wording ("I'm not a robot", "human verification") and error wording
// ("404", "page not found") always surface in innerText; recaptcha/hcaptcha marker
// strings match when embedded in labels, names, or text. A collector upgrade exposing
// iframe/class/alt signals would raise recall further — marked as future work.

const CAPTCHA_MARKERS = /recaptcha|hcaptcha|g-recaptcha|h-captcha/i;
const CAPTCHA_TEXT = /captcha|i'm not a robot|human verification|verify you (are|as) human/i;
// NOTE: bare status codes (e.g. "500" in "₹18,500") misfire on prices/IDs, so
// codes only count with error semantics: "404 not found", "Error 500", etc.
const ERROR_TEXT =
  /\b(404|500|403)\s*(not found|error|forbidden|unavailable|internal)|\berror\s*(404|500|403|4\d\d|5\d\d)|page not found|something went wrong|service unavailable/i;

/**
 * Classify the page from already-collected structural signals, in priority
 * order: captcha → error_page → payment → auth → form → medical → general.
 * Safety stops (captcha/error) outrank everything — first match wins.
 */
export function classifyPage(
  fields: FieldStructure[] | undefined,
  pageText: string,
): PageClassification {
  const inputFields = (fields ?? []).filter(isField);
  const text = typeof pageText === 'string' ? pageText : '';
  const allHaystacks = (fields ?? []).map(fieldHaystack).join(' ');

  // 0a — captcha: explicit markers (0.95) or visible challenge wording (0.95).
  if (CAPTCHA_MARKERS.test(allHaystacks) || CAPTCHA_MARKERS.test(text)) {
    return { pageType: 'captcha', confidence: EXPLICIT_CONFIDENCE };
  }
  if (CAPTCHA_TEXT.test(text)) {
    return { pageType: 'captcha', confidence: EXPLICIT_CONFIDENCE };
  }

  // 0b — error page: HTTP-equivalent / not-found wording (0.90).
  if (ERROR_TEXT.test(text)) {
    return { pageType: 'error_page', confidence: 0.9 };
  }

  // 1 — payment: a telephone input near card/cvv/expiry wording. The co-occurrence of
  // the structural tel type AND payment wording is an explicit, high-confidence signal.
  const hasTel = inputFields.some((field) => field.inputType === 'tel');
  if (hasTel && PAYMENT_LABELS.test(allHaystacks) ) {
    return { pageType: 'payment', confidence: EXPLICIT_CONFIDENCE };
  }
  if (hasTel && PAYMENT_LABELS.test(text)) {
    return { pageType: 'payment', confidence: LABEL_CONFIDENCE };
  }

  // 2 — auth: a password field is explicit; login/sign-in wording alone is weaker.
  if (inputFields.some((field) => field.inputType === 'password')) {
    return { pageType: 'auth', confidence: EXPLICIT_CONFIDENCE };
  }
  if (AUTH_LABELS.test(allHaystacks) || AUTH_LABELS.test(text)) {
    return { pageType: 'auth', confidence: LABEL_CONFIDENCE };
  }

  // 3 — form: enough input fields to be a form, whatever they are for.
  if (inputFields.length >= FORM_FIELD_THRESHOLD) {
    return { pageType: 'form', confidence: STRUCTURAL_CONFIDENCE };
  }

  // 4 — medical wording (checked after the structural rules, per priority order).
  if (MEDICAL_LABELS.test(allHaystacks) || MEDICAL_LABELS.test(text)) {
    return { pageType: 'medical', confidence: LABEL_CONFIDENCE };
  }

  // 5 — default.
  const pageType: VisualPageType = 'general';
  return { pageType, confidence: STRUCTURAL_CONFIDENCE };
}
