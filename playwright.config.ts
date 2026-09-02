import { defineConfig } from '@playwright/test';

// E2E runs the BUILT extension in a real Chromium profile. Extensions require a
// persistent context, so each test launches its own via the fixtures in
// tests/e2e/fixtures.ts rather than using the built-in `browser`/`page` fixtures.
//
// Prerequisite: `npm run build` (the fixture fails loudly if dist/ is absent).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // CI runners are small: 5 concurrent Chromium profiles crash pages mid-test
  // ("session closed", blank-panel flake). Two workers + one retry keeps e2e
  // deterministic there; local runs keep full parallelism with no retries.
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  // Launching Chromium with an unpacked extension is slower than a plain page load.
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
