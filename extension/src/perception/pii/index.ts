import type { SensitiveEntity } from '../../types/contracts';
import { normalizeNumerals } from '../../sanitizer/normalize';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_REGEX = /(?:(?:\+91|0091|91|0)[\s\-.]?)?(?:[6-9]\d{4}[\s\-.]?\d{5}|[6-9]\d{2}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4})/g;
const PHONE_US_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]?){13,19}\b/g;
const CREDENTIAL_REGEX = /(?:api[_-]?key|secret|token|password|bearer|auth|access[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-_.~+/]{8,})["']?/gi;
// Indian PII (SIH 2026): Aadhaar (UIDAI: first digit 2-9, 4-4-4 groups, space/hyphen
// separated), PAN (5 letters + 4 digits + 1 letter), UPI VPA (user@handle, gated).
// Lookarounds keep card-number prefixes (e.g. a 16-digit card's first 12 digits)
// from misfiring as Aadhaar. Existing detectors above are untouched.
const AADHAAR_REGEX = /(?<!\d)(?<![\d][\s-])[2-9][0-9]{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}(?![\s-]?\d)/g;
const PAN_REGEX = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
const UPI_REGEX = /\b[\w.-]{2,256}@[a-zA-Z]{2,64}\b/g;
const UPI_HANDLES = new Set([
  'okicici',
  'oksbi',
  'okaxis',
  'okhdfc',
  'ybl',
  'ibl',
  'upi',
  'paytm',
  'gpay',
  'phonepe',
]);
const UPI_CONTEXT = /(upi|vpa|\bpay\b)/i;

function isValidLuhn(digits: string): boolean {
  const sanitized = digits.replace(/\D/g, '');
  if (sanitized.length < 13 || sanitized.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = sanitized.length - 1; i >= 0; i--) {
    let digit = parseInt(sanitized.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function detectPII(text: string): SensitiveEntity[] {
  if (!text || typeof text !== 'string') return [];

  const entities: SensitiveEntity[] = [];
  // Phase 2 — detect on a normalized copy (Devanagari digits → ASCII), but map
  // every hit back to the ORIGINAL slice so downstream literal redaction and the
  // vault still operate on the true page text. Mapping is 1:1 length-preserving.
  const normalized = normalizeNumerals(text);
  const originalOf = (match: RegExpMatchArray): string => {
    if (match.index === undefined) return match[0] ?? '';
    return text.slice(match.index, match.index + (match[0]?.length ?? 0));
  };

  for (const match of normalized.matchAll(EMAIL_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `email-${match.index}`,
        category: 'EMAIL',
        confidence: 1,
        reasons: ['Matched pattern for EMAIL'],
        source: 'DOM',
        text: originalOf(match),
      } as unknown as SensitiveEntity);
    }
  }

  // Collect Aadhaar spans first to avoid misclassifying Aadhaar groups as phone.
  const aadhaarSpans: Array<{ start: number; end: number }> = [];
  for (const m of normalized.matchAll(AADHAAR_REGEX)) {
    if (m.index !== undefined && m[0]) aadhaarSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  const phoneSpans: Array<{ start: number; end: number }> = [];
  const addPhone = (match: RegExpMatchArray, isIndian: boolean) => {
    if (match.index === undefined || !match[0]) return;
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    if (phoneSpans.some((s) => start < s.end && end > s.start)) return;
    const stripped = raw.replace(/\D/g, '');
    if (isIndian) {
      if (stripped.length < 10 || stripped.length > 14) return;
      const core = stripped.slice(-10);
      if (core.length !== 10 || !/^[6-9]\d{9}$/.test(core)) return;
    } else {
      if (stripped.length < 10 || stripped.length > 11) return;
      const coreUs = stripped.slice(-10);
      if (/^[01]/.test(coreUs)) return;
    }
    const before = normalized[start - 1];
    const after = normalized[end];
    if (before && /\d/.test(before)) return;
    if (after && /\d/.test(after)) return;
    if (aadhaarSpans.some((s) => start < s.end && end > s.start)) return;
    phoneSpans.push({ start, end });
    entities.push({
      id: `phone-${start}`,
      category: 'PHONE_NUMBER',
      confidence: 1,
      reasons: ['Matched pattern for PHONE_NUMBER'],
      source: 'DOM',
      text: originalOf(match),
    } as unknown as SensitiveEntity);
  };
  for (const match of normalized.matchAll(PHONE_REGEX)) addPhone(match, true);
  // US fallback for backward compatibility (existing canaries like 555-123-4567)
  for (const match of normalized.matchAll(PHONE_US_REGEX)) addPhone(match, false);

  for (const match of normalized.matchAll(CREDIT_CARD_REGEX)) {
    if (match.index !== undefined && match[0]) {
      const rawDigits = match[0].replace(/\D/g, '');
      if (isValidLuhn(rawDigits)) {
        entities.push({
          id: `card-${match.index}`,
          category: 'PAYMENT_CARD',
          confidence: 1,
          reasons: ['Matched pattern for PAYMENT_CARD'],
          source: 'DOM',
          text: originalOf(match),
        } as unknown as SensitiveEntity);
      }
    }
  }

  for (const match of normalized.matchAll(CREDENTIAL_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `secret-${match.index}`,
        category: 'CREDENTIAL',
        confidence: 1,
        reasons: ['Matched pattern for CREDENTIAL'],
        source: 'DOM',
        text: originalOf(match),
      } as unknown as SensitiveEntity);
    }
  }

  for (const match of normalized.matchAll(AADHAAR_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `aadhaar-${match.index}`,
        category: 'AADHAAR',
        confidence: 1,
        reasons: ['Matched pattern for AADHAAR'],
        source: 'DOM',
        text: originalOf(match),
      } as unknown as SensitiveEntity);
    }
  }

  for (const match of normalized.matchAll(PAN_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `pan-${match.index}`,
        category: 'PAN',
        confidence: 1,
        reasons: ['Matched pattern for PAN'],
        source: 'DOM',
        text: originalOf(match),
      } as unknown as SensitiveEntity);
    }
  }

  // Email spans first: a UPI candidate inside a real email address (user@host.com)
  // belongs to the email, not to a VPA.
  const emailSpans: { start: number; end: number }[] = [];
  for (const match of normalized.matchAll(EMAIL_REGEX)) {
    if (match.index !== undefined && match[0]) {
      emailSpans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  for (const match of normalized.matchAll(UPI_REGEX)) {
    if (match.index === undefined || !match[0]) continue;
    const start = match.index;
    const end = start + match[0].length;
    // Part of a larger email address (e.g. user@host in user@host.com) — skip.
    if (normalized[end] === '.') continue;
    if (emailSpans.some((s) => start < s.end && end > s.start)) continue;
    const domain = (match[0].split('@')[1] ?? '').toLowerCase();
    const knownHandle = UPI_HANDLES.has(domain);
    const context = normalized.slice(Math.max(0, start - 24), start);
    if (!knownHandle && !UPI_CONTEXT.test(context)) continue;
    entities.push({
      id: `upi-${start}`,
      category: 'UPI',
      confidence: 1,
      reasons: ['Matched pattern for UPI'],
      source: 'DOM',
      text: originalOf(match),
    } as unknown as SensitiveEntity);
  }

  return entities;
}

/**
 * Label-evidence extraction (blueprint §5: sensitivity = f(pattern evidence, DOM input
 * type, label/nearby text, page context)). Complements the pattern detectors above for
 * the categories that have NO reliable pattern — person names and postal addresses —
 * and catches credential-like values whose keyword is separated by whitespace.
 *
 * Only STRICT "Keyword: value" / "Keyword value" shapes are classified; free text
 * without a label is never guessed. Values stay LOCAL in the returned entities
 * exactly like every other `SensitiveEntity.text`.
 */
export function detectLabeledValues(text: string): SensitiveEntity[] {
  if (!text || typeof text !== 'string') return [];

  const entities: SensitiveEntity[] = [];
  // Phase 2 — same normalize-then-map-back as detectPII (see above).
  const normalized = normalizeNumerals(text);
  const originalGroup = (match: RegExpMatchArray, group: string | undefined): string | undefined => {
    if (match.index === undefined || group === undefined) return group;
    const start = match.index + (match[0] ?? '').indexOf(group);
    return text.slice(start, start + group.length);
  };

  // Person names / patients / students introduced by a label. Names contain no
  // commas — the value ends at a section separator (·), a comma, a sentence dot
  // followed by space, or EOL.
  const NAME_LABELED =
    /\b(?:full\s+name|name|patient|student)\s*[:-]\s*([^\n·,]{3,60}?)(?=\s*[·,]|\.\s|\n|$)/gi;
  for (const match of normalized.matchAll(NAME_LABELED)) {
    const value = originalGroup(match, match[1])?.trim();
    if (!value || value.length < 3) continue;
    const keyword = match[0].split(/[:-]/)[0]?.trim().toLowerCase() ?? '';
    entities.push({
      id: `labeled-${keyword}-${match.index}`,
      category: 'NAME',
      confidence: 0.8,
      reasons: [`Label evidence: "${keyword}"`],
      source: 'DOM',
      text: value,
    } as unknown as SensitiveEntity);
  }

  // Postal addresses introduced by a label — commas are legitimate inside an address.
  const ADDRESS_LABELED =
    /\baddress\s*[:-]\s*([^\n·]{3,80}?)(?=\s*[·\n]|\.\s|\n|$)/gi;
  for (const match of normalized.matchAll(ADDRESS_LABELED)) {
    const value = originalGroup(match, match[1])?.trim();
    if (!value || value.length < 3) continue;
    entities.push({
      id: `labeled-address-${match.index}`,
      category: 'ADDRESS',
      confidence: 0.8,
      reasons: ['Label evidence: "address"'],
      source: 'DOM',
      text: value,
    } as unknown as SensitiveEntity);
  }

  // Credential-like values whose keyword is followed by a colon OR whitespace — the
  // pattern-based CREDENTIAL_REGEX above requires [:=], missing shapes like
  // "api_key BENCH_KEY_001" or "Access code: BENCH_SECRET_001".
  const CREDENTIAL_LABELED =
    /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|key|code|otp)\s*[:=\s]\s*["']?([A-Za-z0-9\-_.~+/]{6,})["']?/gi;
  for (const match of normalized.matchAll(CREDENTIAL_LABELED)) {
    const value = originalGroup(match, match[1]);
    if (!value || value.length < 6) continue;
    entities.push({
      id: `labeled-credential-${match.index}`,
      category: 'CREDENTIAL',
      confidence: 0.9,
      reasons: ['Label evidence: credential keyword'],
      source: 'DOM',
      text: value,
    } as unknown as SensitiveEntity);
  }

  return entities;
}