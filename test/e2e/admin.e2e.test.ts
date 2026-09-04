import { describe, expect, it } from 'vitest'
import { adminToken, E2E_ENABLED, get, post } from './helpers.js'

describe.skipIf(!E2E_ENABLED)('E2E: admin', () => {
  it('rejects admin routes without the admin key', async () => {
    const res = await get('/admin/overview')
    expect(res.status).toBe(401)
  })

  it('GET /admin/overview', async () => {
    const res = await get('/admin/overview', adminToken())
    expect(res.status).toBe(200)
    expect(res.body.overview).toBeTruthy()
    expect(typeof res.body.region).toBe('string')
    expect(typeof res.body.version).toBe('string')
  })

  it('GET /admin/network', async () => {
    const res = await get('/admin/network?hours=1', adminToken())
    expect(res.status).toBe(200)
    expect(res.body.window_hours).toBe(1)
    expect(res.body.totals).toBeTruthy()
    expect(Array.isArray(res.body.by_route)).toBe(true)
    expect(Array.isArray(res.body.by_region)).toBe(true)
    expect(Array.isArray(res.body.per_hour)).toBe(true)
  })

  it('GET /admin/storage', async () => {
    const res = await get('/admin/storage', adminToken())
    expect(res.status).toBe(200)
    if (res.body.configured) {
      expect(typeof res.body.total_bytes).toBe('number')
      expect(typeof res.body.total_objects).toBe('number')
    } else {
      expect(res.body).toMatchObject({ configured: false })
    }
  })

  it('GET /admin/costs/overview', async () => {
    const res = await get('/admin/costs/overview?days=7', adminToken())
    expect(res.status).toBe(200)
    expect(res.body.days).toBe(7)
    expect(Array.isArray(res.body.providers)).toBe(true)
    expect(res.body.providers.length).toBeGreaterThan(0)
    expect(typeof res.body.grand_total_usd).toBe('number')
    expect(res.body.free_tier).toBeTruthy()
  })

  it('GET /admin/costs/projection', async () => {
    const res = await get('/admin/costs/projection?mappers=1&sessions_per_day=1&minutes_per_session=5', adminToken())
    expect(res.status).toBe(200)
    expect(res.body.params.mappers).toBe(1)
    expect(res.body.grand_total_usd).toBeGreaterThan(0) // the Apple Developer line is always billable
    expect(Array.isArray(res.body.assumptions)).toBe(true)
  })

  it('GET /admin/costs/pricing', async () => {
    const res = await get('/admin/costs/pricing', adminToken())
    expect(res.status).toBe(200)
    expect(res.body.month_days).toBe(30)
    expect(Array.isArray(res.body.pricing)).toBe(true)
    expect(res.body.pricing.length).toBeGreaterThan(20)
    for (const entry of res.body.pricing) {
      expect(entry).toHaveProperty('unit_price_usd')
      expect(entry).toHaveProperty('free_quota')
      expect(entry).toHaveProperty('source')
      expect(entry).toHaveProperty('as_of')
    }
  })

  it('POST /admin/db/migrate is idempotent', async () => {
    const first = await post('/admin/db/migrate', {}, adminToken())
    expect(first.status).toBe(200)
    expect(Array.isArray(first.body.applied)).toBe(true)
    expect(first.body.applied.length).toBeGreaterThan(0)

    const second = await post('/admin/db/migrate', {}, adminToken())
    expect(second.status).toBe(200)
    expect(second.body.applied).toEqual(first.body.applied)
  })
})
