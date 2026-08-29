// M3 — Playwright fixtures that load the BUILT extension into a real Chromium profile.
//
// Chrome extensions only load in a persistent context, so the standard `browser`/
// `page` fixtures cannot be used. These fixtures are named distinctly (extContext,
// panel) rather than overriding the built-ins, so nothing silently launches a
// second, extension-less browser.
//
// NOTE FOR WHOEVER RUNS THIS NEXT: this suite was authored but NOT executed in the
// development environment, where Chromium cannot be spawned at all (`spawn UNKNOWN`;
// Playwright's own PrintDeps.exe fails to resolve chrome_elf.dll despite a complete
// 428 MB install). See PROJECT_STATUS.md. Treat the first green run as the real
// validation, and expect to adjust selectors/timing rather than assuming correctness.

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Built extension root. `npm run build` must have run first. */
const DIST = resolve(process.cwd(), 'dist');

/** Path of the side panel document inside the packed extension. */
export const PANEL_PATH = 'extension/src/sidepanel/index.html';

/**
 * Synthetic origin for pages under test. Requests are fulfilled locally by
 * Playwright routing, so no real network traffic occurs — but Chrome still sees an
 * https:// document, which is what the extension's host permissions require.
 */
export const TEST_ORIGIN = 'https://privagent.test';

interface ExtensionFixtures {
  extContext: BrowserContext;
  extensionId: string;
  panel: Page;
}

export const test = base.extend<ExtensionFixtures>({
  extContext: async ({ playwright }, use) => {
    if (!existsSync(join(DIST, 'manifest.json'))) {
      throw new Error('dist/manifest.json is missing — run `npm run build` before `npm run e2e`.');
    }

    const userDataDir = await mkdtemp(join(tmpdir(), 'privagent-e2e-'));
    const context = await playwright.chromium.launchPersistentContext(userDataDir, {
      // `channel: 'chromium'` selects the full browser build. The default headless
      // shell cannot load extensions at all.
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });

    await use(context);

    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ extContext }, use) => {
    const worker =
      extContext.serviceWorkers()[0] ?? (await extContext.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },

  panel: async ({ extContext, extensionId }, use) => {
    const page = await extContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/${PANEL_PATH}`);
    await expect(page.locator('h1')).toHaveText('PrivAgent');
    await use(page);
  },
});

/**
 * Serves `html` at TEST_ORIGIN and opens it in a new tab, fulfilled locally.
 *
 * The tab is left focused so that the background worker's
 * `tabs.query({ active: true, currentWindow: true })` resolves to it rather than to
 * the side panel tab — the side panel is a real panel in production, not a tab.
 */
export async function openTestPage(context: BrowserContext, html: string): Promise<Page> {
  await context.route(`${TEST_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );

  const page = await context.newPage();
  await page.goto(`${TEST_ORIGIN}/page`);
  await page.bringToFront();
  return page;
}

/**
 * Triggers the side panel's visual check.
 *
 * `dispatchEvent` rather than `click`: the panel is deliberately a background tab
 * here (see openTestPage), and Playwright's click actionability checks are unreliable
 * against unfocused tabs. React's handler still receives the bubbled event.
 */
export async function runVisualCheck(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: 'Run Visual Check' }).dispatchEvent('click');
  await expect(panel.getByRole('button', { name: 'Run Visual Check' })).toBeEnabled();
}

/** The status line rendered by the VisualStatus widget. */
export function statusLine(panel: Page) {
  return panel.locator('section p.font-medium');
}

export { expect } from '@playwright/test';
