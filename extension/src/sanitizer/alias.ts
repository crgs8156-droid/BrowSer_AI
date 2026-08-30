// M5 — alias allocation, category normalisation, and literal text redaction.
//
// Shared by the low-level `Sanitizer` text primitive (`./index`) and the
// policy-driven enforcement orchestrator (`./enforce`). Kept in its own module
// so both can import it without a circular dependency.
//
// PRIVACY: an alias preserves only the SEMANTIC TYPE of the value it stands for
// (`USER_EMAIL_1`) and contains no fragment of the original secret. The
// value→alias index below lives in memory for the lifetime of one allocator and
// is never logged, serialised, or persisted — it exists so the same value maps
// to the same alias within a task (blueprint §8: aliases are stable and unique).

import type { AliasBinding, SensitiveCategory } from '../types/contracts';

const CATEGORY_ALIASES: Readonly<Record<string, SensitiveCategory>> = {
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  PHONE_NUMBER: 'PHONE',
  NAME: 'NAME',
  ADDRESS: 'ADDRESS',
  PASSWORD: 'PASSWORD',
  CREDENTIAL: 'PASSWORD',
  OTP: 'OTP',
  PAYMENT: 'PAYMENT',
  PAYMENT_CARD: 'PAYMENT',
  ID: 'ID',
  CUSTOM: 'CUSTOM',
};

/**
 * Map any category string (including the M2 detector's PHONE_NUMBER /
 * PAYMENT_CARD / CREDENTIAL variants) to a declared `SensitiveCategory`. Unknown
 * strings fall back to CUSTOM — never dropped, never guessed as non-sensitive.
 */
export function toSensitiveCategory(raw: string): SensitiveCategory {
  return CATEGORY_ALIASES[raw.toUpperCase()] ?? 'CUSTOM';
}

export interface AliasAllocation {
  alias: string;
  category: SensitiveCategory;
  /** True the first time a value is aliased; false on every stable re-use. */
  isNew: boolean;
}

export interface AliasAllocator {
  aliasFor(value: string, category: SensitiveCategory): AliasAllocation;
  /** Distinct alias bindings in allocation order — types only, never values. */
  bindings(): AliasBinding[];
}

/**
 * Allocate stable, unique, semantic aliases. The same value re-uses its alias
 * (stability); distinct values of the same category get incrementing indices
 * (uniqueness). Deterministic given the order values are first presented.
 */
export function createAliasAllocator(): AliasAllocator {
  const byValue = new Map<string, AliasBinding>();
  const counters = new Map<SensitiveCategory, number>();
  const order: AliasBinding[] = [];

  return {
    aliasFor(value, category) {
      const existing = byValue.get(value);
      if (existing) return { alias: existing.alias, category: existing.category, isNew: false };
      const n = (counters.get(category) ?? 0) + 1;
      counters.set(category, n);
      const binding: AliasBinding = { alias: `USER_${category}_${n}`, category };
      byValue.set(value, binding);
      order.push(binding);
      return { alias: binding.alias, category, isNew: true };
    },
    bindings() {
      return order.slice();
    },
  };
}

/**
 * Replace every occurrence of each raw value with its alias, using literal
 * string substitution (no regex — avoids escaping bugs and ReDoS). Longer values
 * are replaced first so a value that is a substring of another cannot corrupt the
 * longer replacement; this makes overlapping values deterministic.
 */
export function redact(
  text: string,
  pairs: readonly { value: string; alias: string }[],
): string {
  if (!text) return text;
  const ordered = pairs
    .filter((p) => p.value.length > 0)
    .slice()
    .sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const { value, alias } of ordered) {
    out = out.split(value).join(alias);
  }
  return out;
}
