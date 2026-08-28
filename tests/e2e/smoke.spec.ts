import { expect, test } from '@playwright/test';

// M1 validation: ensures the side panel loads and DOM context can be collected.
test('side panel loads and displays context', async ({ page }) => {
  await page.goto('chrome-extension://<extension-id>/src/sidepanel/index.html');
  await expect(page.locator('h1')).toHaveText('PrivAgent');
  await page.locator('button').click();
  await expect(page.locator('ul li')).not.toHaveCount(0);
});
