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
  await expect(page.getByRole('button', { name: 'Refresh Context' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Visual perception' })).toBeVisible();
  expect(errors).toEqual([]);
});

// M1 regression: DOM context collection still works end to end.
test('collects DOM context from a real page', async ({ extContext, panel }) => {
  await openTestPage(extContext, TEXT_PAGE);

  await panel.getByRole('button', { name: 'Refresh Context' }).dispatchEvent('click');

  // Scoped to the M1 list (a direct child of <main>) so the M3 observation list
  // cannot satisfy this assertion.
  await expect(panel.locator('main > ul > li').first()).toBeVisible();
});
