import { defineConfig } from '@playwright/test';

// M0: validates the Playwright + Chromium setup. Extension-loading E2E is added later.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    headless: true,
  },
});
