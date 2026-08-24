import type { SensitiveEntity } from '../types/contracts';

// Semantic sanitizer (blueprint §7): replaces protected values with stable typed aliases,
// preserving semantic role. Implemented in M5. Must never emit the raw value or the mapping.
export interface SanitizeResult {
  text: string;
  aliases: string[];
}

export interface Sanitizer {
  sanitize(_entities: SensitiveEntity[], _pageText: string): Promise<SanitizeResult>;
}

export function createSanitizer(): Sanitizer {
  return {
    sanitize() {
      throw new Error('PrivAgent: Sanitizer.sanitize not implemented (M5).');
    },
  };
}
