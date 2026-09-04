import { defineConfig } from 'vitest/config'

/**
 * The E2E suite (PLAN §6) talks to a real deployment over HTTP: signed GCS uploads and Ably token
 * requests are slower than unit tests, so this config gets its own generous timeouts and does not
 * run as part of `npm test` / `vitest.config.ts`.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
