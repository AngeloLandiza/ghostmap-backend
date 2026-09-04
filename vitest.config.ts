import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Unit tests only (PLAN §6): no database, no network. `test/e2e/**` has its own config and its own
 * `npm run test:e2e` script — excluded here so `npm test` never needs the E2E_* secrets.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
})
