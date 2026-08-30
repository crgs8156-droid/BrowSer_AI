// E2E smoke: the built extension loads into real Chromium and the side panel works.
//
// Replaces the M1 placeholder, which navigated to the literal string
// `chrome-extension://<extension-id>/src/sidepanel/index.html` — an unsubstituted
// placeholder pointing at a path the build does not emit. It could never have passed.

import { expect, openTestPage, test, PANEL_PATH } from './fixtures';

const TEXT_PAGE = `<!doctype html>
<html><body>
  <h1>Synthetic test page</h1>
  <p>All content here is synthetic. No real personal data is used.</p>
</body></html>`;

test('service worker registers under the extension origin', async ({
  extContext,
  extensionId,
}) => {
  const worker =
    extContext.serviceWorkers()[0] ?? (await extContext.waitForEvent('serviceworker'));

  expect(extensionId).toMatch(/^[a-p]{32}$/);
  expect(worker.url()).toContain(`chrome-extension://${extensionId}/`);
});

test('side panel document renders without console errors', async ({ extContext, extensionId }) => {
  const errors: string[] = [];
  const page = await extContext.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(`chrome-extension://${extensionId}/${PANEL_PATH}`);

  await expect(page.locator('h1')).toHaveText('PrivAgent');
  await expect(page.getByRole('button', { name: 'Scan Page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Visual perception' })).toBeVisible();
  expect(errors).toEqual([]);
});

// The side panel renders a concise, sanitized summary — never a raw page dump.
test('scans a real page into a concise summary, with no raw dump', async ({
  extContext,
  panel,
}) => {
  await openTestPage(extContext, TEXT_PAGE);

  await panel.getByRole('button', { name: 'Scan Page' }).dispatchEvent('click');

  await expect(panel.getByText('Scan: ✓ Complete')).toBeVisible();
  await expect(panel.getByText('Sensitive items:')).toBeVisible();

  // Regression: the M1 raw DOM dump (a <ul> that was a direct child of <main>) is gone.
  await expect(panel.locator('main > ul > li')).toHaveCount(0);
  // And the page's raw heading text never appears in the panel.
  await expect(panel.getByText('Synthetic test page')).toHaveCount(0);
});
