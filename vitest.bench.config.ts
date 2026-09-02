import { defineConfig } from 'vitest/config';

// Benchmark-only config (`npm run bench`): includes the PrivAgent-Bench suites, which
// write report artifacts under benchmark/reports/. Kept OUT of the default `npm test`
// include so unit/integration runs stay artifact-free.

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/benchmark/**/*.bench.ts'],
  },
});
