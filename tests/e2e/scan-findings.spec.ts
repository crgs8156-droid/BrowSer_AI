// E2E — the full scan flow against a synthetic sensitive page, driven through the real
// production path: side panel "Scan Page" → background relay → content script →
// M2 PII + M3 visual + M4 policy + M5 enforce → concise, sanitized summary.
//
// Proves: (1) multiple text findings surface as distinct aliases; (2) below-the-fold
// text is covered (USER_EMAIL_2 sits in section 3); (3) a critical credential blocks
// outbound; (4) NO raw value and NO raw page heading ever reach the panel (no dump).
//
// SYNTHETIC DATA ONLY (CLAUDE.md §15) — see tests/fixtures/sensitive-sample.html.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openTestPage, test } from './fixtures';

const SAMPLE_HTML = readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'sensitive-sample.html'),
  'utf8',
);

// Raw synthetic values that must NEVER appear in the panel.
const RAW_VALUES = [
  'sample_user_7781@example.test',
  'form_user_7782@example.test',
  'below_fold_user_7783@example.test',
  '+1-202-555-0148',
  '4111111111111111',
  'sk_test_synthetic_abcdef0123456789',
];

test('renders a concise multi-region summary and blocks on a critical credential', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, SAMPLE_HTML);
  await panel.getByRole('button', { name: 'Scan Page' }).dispatchEvent('click');

  await expect(panel.getByText('Scan: ✓ Complete')).toBeVisible();

  // Text detection runs without a viewport capture, so these aliases are deterministic.
  for (const alias of [
    'USER_EMAIL_1',
    'USER_EMAIL_2', // below-the-fold email → proves whole-page text coverage
    'USER_PHONE_1',
    'USER_PAYMENT_1',
    'USER_PASSWORD_1',
  ]) {
    await expect(panel.getByText(alias, { exact: false })).toBeVisible();
  }

  // At least the five text findings above.
  const itemsText = await panel.getByText(/Sensitive items:/).textContent();
  const count = Number(/Sensitive items:\s*(\d+)/.exec(itemsText ?? '')?.[1] ?? '0');
  expect(count).toBeGreaterThanOrEqual(5);

  // The api_key credential is critical → outbound is blocked (fail-closed).
  await expect(panel.getByText(/outbound blocked/)).toBeVisible();

  // NO DUMP: no raw value and no raw page heading text reaches the panel.
  const panelText = (await panel.locator('main').textContent()) ?? '';
  for (const raw of RAW_VALUES) {
    expect(panelText).not.toContain(raw);
  }
  expect(panelText).not.toContain('Acme Synthetic Account');
});
