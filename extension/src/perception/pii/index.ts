import type { SensitiveEntity } from '../../types/contracts';

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]?){13,19}\b/g;
const CREDENTIAL_REGEX = /(?:api[_-]?key|secret|token|password|bearer|auth|access[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-_\.~+/]{8,})["']?/gi;

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