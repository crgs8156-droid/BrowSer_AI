import { expect, test } from '@playwright/test';

// M0 setup validation only: proves the Playwright toolchain runs a real browser.
// It does NOT load the extension (that harness arrives with the leakage sentinel in M7).
test('playwright can render and query DOM', async ({ page }) => {
  await page.setContent('<main><h1 id="t">PrivAgent</h1></main>');
  await expect(page.locator('#t')).toHaveText('PrivAgent');
});
