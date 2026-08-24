import type { SensitiveEntity } from '../../types/contracts';

// DOM/accessibility perception (blueprint §5). Implemented in M1.
export interface DomCollector {
  collect(_root?: Document): Promise<SensitiveEntity[]>;
}

export function createDomCollector(): DomCollector {
  return {
    collect() {
      throw new Error('PrivAgent: DomCollector.collect not implemented (M1).');
    },
  };
}
