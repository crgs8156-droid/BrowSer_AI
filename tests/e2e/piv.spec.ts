// PIV e2e: the My Data tab renders templates masked with zero raw values.
// Synthetic canaries only (CONTRIBUTING.md §15).

import { expect, test } from './fixtures';

const CANARY_EMAIL = 'CANARY_PIV_E2E_001@example.test';

test('my data tab renders masked templates with no raw values', async ({ panel }) => {
  await panel.getByTestId('tab-mydata').dispatchEvent('click');
  await expect(panel.getByTestId('piv-panel')).toBeVisible();
  await expect(panel.getByTestId('piv-notice')).toContainText('Stored locally on this device only');
  // Template alias hints are safe to show; no values exist yet.
  await expect(panel.getByTestId('piv-section-contact')).toBeVisible();
  const body = (await panel.locator('body').textContent()) ?? '';
  expect(body).not.toContain(CANARY_EMAIL);
});

test('piv add flow masks the typed value and rejects bad aliases', async ({ panel }) => {
  await panel.getByTestId('tab-mydata').dispatchEvent('click');
  await panel.getByTestId('piv-add-open').dispatchEvent('click');
  await panel.getByTestId('piv-add-cat-contact').dispatchEvent('click');
  await panel.getByTestId('piv-add-label').fill('Personal Email');
  await panel.getByTestId('piv-add-value').fill(CANARY_EMAIL);
  await panel.getByTestId('piv-add-alias').fill('NOT_AN_ALIAS');
  await panel.getByTestId('piv-add-save').dispatchEvent('click');
  // Invalid aliasHint rejected clearly — never silently fixed.
  await expect(panel.getByTestId('piv-form-error')).toContainText('USER_EMAIL_1');
  await panel.getByTestId('piv-add-alias').fill('USER_EMAIL_1');
  await panel.getByTestId('piv-add-save').dispatchEvent('click');
  // Entry saved: expand the section, masked row visible, raw canary never in DOM.
  await panel.getByTestId('piv-section-contact').dispatchEvent('click');
  await expect(panel.getByText('Personal Email')).toBeVisible();
  const body = (await panel.locator('body').textContent()) ?? '';
  expect(body).not.toContain(CANARY_EMAIL);
});
