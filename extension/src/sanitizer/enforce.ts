// M5 — privacy enforcement orchestrator.
//
// Consumes the signals M4 already reduces, calls `decidePolicyReport` to get the
// per-finding decisions, and NEUTRALISES every applicable finding before any
// content can reach a `RemoteAgentRequest`:
//   - a finding whose value we can recover (via findingId → SensitiveEntity.text)
//     and whose action is not ALLOW  → the value is aliased out of the text and
//     the alias↔value mapping is stored in the LOCAL vault;
//   - a finding with a region (bbox)  → the region becomes a mask directive;
//   - a malformed finding             → kept as `flagged` (fail closed);
//   - a finding we can neither redact nor mask → `inaccessible` (fail closed).
//
// No finding is ever dropped. `enforced` is true only when every finding was
// neutralised AND the page is not uncertain; the caller/firewall must still
// refuse to send when `blocked`, `restricted`, or `!enforced` (CLAUDE.md §5).
//
// PRIVACY: the returned `EnforcementResult` carries aliases (type only),
// geometry, and dispositions — never a raw value, pixels, or a screenshot. Raw
// values live only in the vault. This module performs no logging and no network.

import type {
  EnforcementResult,
  FindingDisposition,
  FindingEnforcement,
  PolicySignals,
  SensitiveEntity,
} from '../types/contracts';
import { decidePolicyReport } from '../policy';
import type { LocalVault } from '../vault';
import { createAliasAllocator, redact, toSensitiveCategory } from './alias';
import { mergeMaskRegions, type MaskInput } from './mask';

export interface EnforceInput {
  /** The same signals M4 consumes: { entities?, visual?, restricted? }. */
  signals: PolicySignals;
  /** The visible text that would otherwise be sent; aliased in the result. */
  pageText: string;
  /** Task/session scope for the vault (mappings are cleared per session). */
  sessionId: string;
  /** Local alias↔value store. Never serialised or transmitted. */
  vault: LocalVault;
  /** Injectable clock for `AliasRecord.createdAt`. Defaults to Date.now. */
  now?: () => number;
}

/** Actions for which a recoverable raw text value must be removed from output. */
const REDACT_ACTIONS: ReadonlySet<string> = new Set(['WARN', 'SANITIZE', 'BLOCK']);
/** Page-level reasons that mean "M5 cannot certify this page as safe". */
const UNCERTAIN_REASONS: ReadonlySet<string> = new Set([
  'SIGNAL_UNAVAILABLE',
  'MALFORMED_SIGNAL',
  'RESTRICTED_CONTEXT',
]);

export async function enforcePrivacy(input: EnforceInput): Promise<EnforcementResult> {
  const { sessionId, vault } = input;
  const signals: PolicySignals = input.signals ?? {};
  const pageText = typeof input.pageText === 'string' ? input.pageText : '';
  const now = input.now ?? Date.now;

  const report = decidePolicyReport(signals);

  // Index the raw entities by their upstream id so a finding can recover the
  // value it must redact. Only well-formed, identifiable entities are indexed.
  const entityById = new Map<string, SensitiveEntity>();
  const rawEntities = Array.isArray(signals.entities) ? signals.entities : [];
  for (const e of rawEntities) {
    if (e && typeof e.id === 'string' && e.id.length > 0) entityById.set(e.id, e);
  }

  const allocator = createAliasAllocator();
  const redactPairs: { value: string; alias: string }[] = [];
  const maskInputs: MaskInput[] = [];
  const findings: FindingEnforcement[] = [];
  const vaultWrites: Promise<void>[] = [];
  let blocked = report.overall.action === 'BLOCK';

  for (const f of report.findings) {
    if (f.action === 'BLOCK') blocked = true;

    const findingId = f.ref.findingId;
    const bbox = f.ref.bbox;

    // Malformed → keep for caution, never certify. Mask geometry if salvageable.
    if (f.reasonCode === 'MALFORMED_SIGNAL') {
      if (bbox) maskInputs.push({ bbox, findingId: findingId ?? 'malformed', source: f.ref.source });
      findings.push({ ref: f.ref, action: f.action, severity: f.severity, disposition: 'flagged' });
      continue;
    }

    const entity = findingId ? entityById.get(findingId) : undefined;
    const rawValue =
      entity && typeof entity.text === 'string' && entity.text.length > 0 ? entity.text : undefined;

    let alias: string | undefined;
    if (rawValue && REDACT_ACTIONS.has(f.action)) {
      const category = toSensitiveCategory(entity!.category);
      const allocation = allocator.aliasFor(rawValue, category);
      alias = allocation.alias;
      // Only push a redaction pair once per distinct value; split/join already
      // replaces every occurrence across the whole text.
      if (allocation.isNew) redactPairs.push({ value: rawValue, alias });
      // The raw value lives ONLY here, in the local vault.
      vaultWrites.push(vault.put({ alias, category, sessionId, createdAt: now() }, rawValue));
    }

    let masked = false;
    if (bbox) {
      maskInputs.push({ bbox, findingId: findingId ?? 'region', source: f.ref.source });
      masked = true;
    }

    // No value to redact and no region to mask ⇒ we were told about a finding we
    // cannot act on. Fail closed: record it, never claim it was sanitised.
    const disposition: FindingDisposition = alias ? 'aliased' : masked ? 'masked' : 'inaccessible';
    const fe: FindingEnforcement = {
      ref: f.ref,
      action: f.action,
      severity: f.severity,
      disposition,
    };
    if (alias) fe.alias = alias;
    findings.push(fe);
  }

  await Promise.all(vaultWrites);

  const restricted =
    signals.restricted === true || report.overall.reasonCode === 'RESTRICTED_CONTEXT';
  const allNeutralised = findings.every(
    (f) => f.disposition === 'aliased' || f.disposition === 'masked',
  );
  const enforced = allNeutralised && !UNCERTAIN_REASONS.has(report.overall.reasonCode);
  // Fail closed: emit usable cleartext ONLY when the page is fully safe to
  // proceed. If any finding is unresolved, the page is blocked, or the surface is
  // restricted, we cannot guarantee the text is clean — so we withhold it rather
  // than risk handing an unidentified raw value downstream (CLAUDE.md §5 Rule 7).
  const safe = enforced && !blocked && !restricted;

  return {
    sanitizedText: safe ? redact(pageText, redactPairs) : '',
    aliases: allocator.bindings(),
    visualMasks: mergeMaskRegions(maskInputs),
    findings,
    blocked,
    restricted,
    enforced,
    local: true,
  };
}
