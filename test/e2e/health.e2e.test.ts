import { describe, expect, it } from 'vitest'
import { E2E_ENABLED, get } from './helpers.js'

describe.skipIf(!E2E_ENABLED)('E2E: health', () => {
  it('GET /health answers without auth', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(typeof res.body.version).toBe('string')
    expect(typeof res.body.time).toBe('string')
  })
})
