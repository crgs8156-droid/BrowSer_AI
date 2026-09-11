// PIV ↔ agent bridge helpers (pure, no I/O).
//
// Maps a PIV aliasHint to the session vault's SensitiveCategory via the
// existing normalizer. Unknown segments (FIRSTNAME, DOB, CITY, …) fall back
// to CUSTOM — the alias grammar still holds, so the firewall stays green
// and the bridge resolves locally as usual.

import { toSensitiveCategory } from '../sanitizer/alias';
import type { SensitiveCategory } from '../types/contracts';
import type { PIVEntry } from './store';

export function categoryFromAlias(aliasHint: string): SensitiveCategory {
  const segment = aliasHint.split('_')[1] ?? '';
  return toSensitiveCategory(segment);
}

/** Entries safe to register: non-empty value and well-formed alias hint. */
export function registrableEntries(entries: PIVEntry[]): PIVEntry[] {
  return entries.filter(
    (e) => e.value.length > 0 && /^USER_[A-Z]+_\d+$/.test(e.aliasHint),
  );
}
