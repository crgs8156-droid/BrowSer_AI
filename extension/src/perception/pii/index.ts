import type { SensitiveEntity } from '../../types/contracts';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]?){13,19}\b/g;
const CREDENTIAL_REGEX = /(?:api[_-]?key|secret|token|password|bearer|auth|access[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-_.~+/]{8,})["']?/gi;

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

  for (const match of text.matchAll(EMAIL_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `email-${match.index}`,
        category: 'EMAIL',
        confidence: 1,
        reasons: ['Matched pattern for EMAIL'],
        source: 'DOM',
        text: match[0],
      } as unknown as SensitiveEntity);
    }
  }

  for (const match of text.matchAll(PHONE_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `phone-${match.index}`,
        category: 'PHONE_NUMBER',
        confidence: 1,
        reasons: ['Matched pattern for PHONE_NUMBER'],
        source: 'DOM',
        text: match[0],
      } as unknown as SensitiveEntity);
    }
  }

  for (const match of text.matchAll(CREDIT_CARD_REGEX)) {
    if (match.index !== undefined && match[0]) {
      const rawDigits = match[0].replace(/\D/g, '');
      if (isValidLuhn(rawDigits)) {
        entities.push({
          id: `card-${match.index}`,
          category: 'PAYMENT_CARD',
          confidence: 1,
          reasons: ['Matched pattern for PAYMENT_CARD'],
          source: 'DOM',
          text: match[0],
        } as unknown as SensitiveEntity);
      }
    }
  }

  for (const match of text.matchAll(CREDENTIAL_REGEX)) {
    if (match.index !== undefined && match[0]) {
      entities.push({
        id: `secret-${match.index}`,
        category: 'CREDENTIAL',
        confidence: 1,
        reasons: ['Matched pattern for CREDENTIAL'],
        source: 'DOM',
        text: match[0],
      } as unknown as SensitiveEntity);
    }
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

  // Person names / patients / students introduced by a label. Names contain no
  // commas — the value ends at a section separator (·), a comma, a sentence dot
  // followed by space, or EOL.
  const NAME_LABELED =
    /\b(?:full\s+name|name|patient|student)\s*[:-]\s*([^\n·,]{3,60}?)(?=\s*[·,]|\.\s|\n|$)/gi;
  for (const match of text.matchAll(NAME_LABELED)) {
    const value = match[1]?.trim();
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
  for (const match of text.matchAll(ADDRESS_LABELED)) {
    const value = match[1]?.trim();
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
  for (const match of text.matchAll(CREDENTIAL_LABELED)) {
    const value = match[1];
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