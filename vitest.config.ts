import { defineConfig } from 'vitest/config';

// Unit/integration tests run in a plain Node environment and do NOT load the
// extension build plugins (crx/tailwind). Browser E2E lives under tests/e2e (Playwright).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
  },
});
