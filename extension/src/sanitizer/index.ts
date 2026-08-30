import type { SensitiveEntity } from '../types/contracts';
import { createAliasAllocator, redact, toSensitiveCategory } from './alias';

// Semantic sanitizer (blueprint §7): replaces protected values with stable typed
// aliases, preserving semantic role. This is the low-level TEXT primitive; the
// policy-driven M5 entry point that consumes M4 findings, writes the vault, and
// handles visual regions is `enforcePrivacy` in `./enforce`.
//
// PRIVACY: emits the aliased text and alias NAMES only — never the raw value and
// never the alias↔value mapping (that lives solely in the local vault).

export interface SanitizeResult {
  text: string;
  aliases: string[];
}

export interface Sanitizer {
  sanitize(entities: SensitiveEntity[], pageText: string): Promise<SanitizeResult>;
}

export function createSanitizer(): Sanitizer {
  return {
    async sanitize(entities, pageText) {
      const text = typeof pageText === 'string' ? pageText : '';
      const allocator = createAliasAllocator();
      const indexOfValue = (value: string): number => {
        const i = text.indexOf(value);
        return i < 0 ? text.length + 1 : i;
      };
      // Allocate aliases in document order (then by value) so the mapping is
      // deterministic regardless of the order entities were detected in.
      const withText = (Array.isArray(entities) ? entities : [])
        .filter(
          (e): e is SensitiveEntity & { text: string } =>
            !!e && typeof e.text === 'string' && e.text.length > 0,
        )
        .sort((a, b) => {
          const d = indexOfValue(a.text) - indexOfValue(b.text);
          return d !== 0 ? d : a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
        });
      const pairs = withText.map((e) => ({
        value: e.text,
        alias: allocator.aliasFor(e.text, toSensitiveCategory(e.category)).alias,
      }));
      return { text: redact(text, pairs), aliases: allocator.bindings().map((b) => b.alias) };
    },
  };
}

// M5 barrel — the enforcement orchestrator and primitives.
export { toSensitiveCategory, createAliasAllocator, redact } from './alias';
export type { AliasAllocation, AliasAllocator } from './alias';
export { mergeMaskRegions, applyMasks } from './mask';
export type { PixelBuffer, MaskInput } from './mask';
export { enforcePrivacy } from './enforce';
export type { EnforceInput } from './enforce';
