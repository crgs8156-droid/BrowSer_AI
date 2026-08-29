import { defineConfig } from '@playwright/test';

// E2E runs the BUILT extension in a real Chromium profile. Extensions require a
// persistent context, so each test launches its own via the fixtures in
// tests/e2e/fixtures.ts rather than using the built-in `browser`/`page` fixtures.
//
// Prerequisite: `npm run build` (the fixture fails loudly if dist/ is absent).
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  // Launching Chromium with an unpacked extension is slower than a plain page load.
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
