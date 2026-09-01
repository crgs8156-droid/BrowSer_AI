// Integration leakage test: real M2 detection → M5 enforcement → display summary.
//
// Invariant (CONTRIBUTING.md §5/§13): a raw protected value fed into the pipeline must NEVER
// appear in the display summary the side panel renders — not in a field, not in a
// displayId, not anywhere in its JSON serialisation. Synthetic canaries only (§15).

import { describe, expect, it } from 'vitest';
import { detectPII } from '../../extension/src/perception/pii';
import { enforcePrivacy } from '../../extension/src/sanitizer';
import { createLocalVault } from '../../extension/src/vault';
import { buildScanSummary } from '../../extension/src/scan/summary';
import type { PolicySignals } from '../../extension/src/types/contracts';

// Synthetic canaries — these must never escape the local boundary into the summary.
const CANARY_EMAIL = 'canary_leak_5501@example.test';
const CANARY_EMAIL_2 = 'below_fold_canary_5502@example.test';
const CANARY_PHONE = '+1-202-555-0173';
const CANARY_CARD = '4111111111111111'; // valid-Luhn synthetic
const CANARY_SECRET = 'api_key: sk_test_canary_abcdef0123456789';

const PAGE_TEXT = [
  `Primary contact: ${CANARY_EMAIL}`,
  `Phone: ${CANARY_PHONE}`,
  `Card on file: ${CANARY_CARD}`,
  CANARY_SECRET,
  // Simulated below-the-fold text — innerText carries the whole document.
  `Secondary contact (below the fold): ${CANARY_EMAIL_2}`,
].join('\n');

async function runPipeline() {
  const entities = detectPII(PAGE_TEXT);
  const signals: PolicySignals = { entities, restricted: false };
  const vault = createLocalVault();
  const result = await enforcePrivacy({
    signals,
    pageText: PAGE_TEXT,
    sessionId: 'leakage-test',
    vault,
  });
  return { result, summary: buildScanSummary(result, 800), vault };
}

describe('M2→M5→summary — no raw value reaches the display summary', () => {
  it('detects the canaries as text findings and aliases them (below-fold included)', async () => {
    const { summary } = await runPipeline();

    // Both emails (one below the fold) surface as distinct aliases → proves whole-page
    // text coverage and multi-region handling.
    const ids = summary.findings.map((f) => f.displayId);
    expect(ids).toContain('USER_EMAIL_1');
    expect(ids).toContain('USER_EMAIL_2');
    expect(summary.textCount).toBeGreaterThanOrEqual(4);
  });

  it('never serialises any raw canary into the summary', async () => {
    const { summary } = await runPipeline();
    const json = JSON.stringify(summary);

    for (const canary of [CANARY_EMAIL, CANARY_EMAIL_2, CANARY_PHONE, CANARY_CARD, CANARY_SECRET]) {
      expect(json).not.toContain(canary);
    }
  });

  it('never embeds a raw canary in any displayId', async () => {
    const { summary } = await runPipeline();
    for (const finding of summary.findings) {
      for (const canary of [CANARY_EMAIL, CANARY_EMAIL_2, CANARY_PHONE, CANARY_CARD]) {
        expect(finding.displayId).not.toContain(canary);
      }
      // Aliases follow the semantic USER_<CATEGORY>_<n> shape — no secret fragment.
      expect(finding.displayId).toMatch(/^(USER_[A-Z]+_\d+|IMAGE_REGION_\d+|UNRESOLVED_\d+)$/);
    }
  });

  it('keeps the raw values recoverable ONLY via the local vault', async () => {
    const { vault } = await runPipeline();
    // The alias→value mapping is local; the value is retrievable here but never in the
    // summary (asserted above). This proves aliasing, not deletion.
    await expect(vault.resolve('USER_EMAIL_1')).resolves.toBeTypeOf('string');
  });
});
