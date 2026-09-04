import { beforeAll, describe, expect, it } from 'vitest'

process.env.AUTH_JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.ADMIN_API_KEY = 'admin-key-1234'
process.env.CLIENT_ACCESS_KEYS = 'client-key-1234'
process.env.WORKER_API_KEY = 'worker-key-1234'
process.env.DATABASE_URL = 'postgres://u:p@localhost/db'
process.env.NODE_ENV = 'test'

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})

describe('routes (no database needed)', () => {
  let app: typeof import('../src/app.js')['app']
  let mint: typeof import('../src/lib/auth.js')['mintToken']
  const tokens: Record<'device' | 'client' | 'user', string> = { device: '', client: '', user: '' }

  beforeAll(async () => {
    app = (await import('../src/app.js')).app
    mint = (await import('../src/lib/auth.js')).mintToken
    tokens.device = (await mint({ role: 'device', device_id: '11111111-1111-4111-8111-111111111111' })).token
    tokens.client = (await mint({ role: 'client' })).token
    tokens.user = (await mint({ role: 'user', user_id: '22222222-2222-4222-8222-222222222222', email: 'a@example.com' })).token
  })

  it('serves health without auth', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('rejects admin routes without credentials', async () => {
    const res = await app.request('/admin/network')
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  it('forbids client tokens on device-only routes', async () => {
    const res = await app.request('/v1/maps', json({ name: 'x' }, tokens.client))
    expect(res.status).toBe(403)
  })

  it('validates JSON bodies', async () => {
    const res = await app.request('/v1/auth/token', json({}))
    expect(res.status).toBe(400)
  })

  it('rejects unknown access keys', async () => {
    const res = await app.request('/v1/auth/token', json({ access_key: 'not-a-key' }))
    expect(res.status).toBe(401)
  })

  describe('POST /v1/auth/google', () => {
    it('validates the body before doing any work', async () => {
      expect((await app.request('/v1/auth/google', json({}))).status).toBe(400)
      expect((await app.request('/v1/auth/google', json({ id_token: 'tiny' }))).status).toBe(400)
    })

    it('reports 501 when GOOGLE_CLIENT_IDS is not configured', async () => {
      const res = await app.request('/v1/auth/google', json({ id_token: 'x'.repeat(40) }))
      expect(res.status).toBe(501)
      expect((await res.json()).error.code).toBe('not_configured')
    })
  })

  describe('GET /v1/auth/me', () => {
    it('needs credentials', async () => {
      expect((await app.request('/v1/auth/me')).status).toBe(401)
    })

    it('answers for any authenticated role', async () => {
      const res = await app.request('/v1/auth/me', { headers: { Authorization: 'Bearer admin-key-1234' } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ role: 'admin', device_id: null, user: null })
    })

    it('reports the device a token is bound to', async () => {
      const res = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${tokens.client}` } })
      expect(await res.json()).toMatchObject({ role: 'client', device_id: null })
    })
  })

  describe('the user role', () => {
    it('carries user_id and email through a JWT round trip', async () => {
      const { verifyToken } = await import('../src/lib/auth.js')
      const p = await verifyToken(tokens.user)
      expect(p).toMatchObject({ role: 'user', userId: '22222222-2222-4222-8222-222222222222', email: 'a@example.com' })
    })

    it('passes auth on maps and sessions (validation, not 403, rejects the empty body)', async () => {
      expect((await app.request('/v1/maps', json({}, tokens.user))).status).toBe(400)
      expect((await app.request('/v1/sessions', json({}, tokens.user))).status).toBe(400)
    })

    it('is refused on the device-only legacy routes', async () => {
      expect((await app.request('/v1/devices/me', { headers: { Authorization: `Bearer ${tokens.user}` } })).status).toBe(403)
      const kf = { keyframes: [{ seq: 1, t: 0, pose: Array(16).fill(0), intrinsics: { fx: 1, fy: 1, cx: 1, cy: 1, w: 2, h: 2 } }] }
      expect((await app.request('/v1/sessions/33333333-3333-4333-8333-333333333333/keyframes', json(kf, tokens.user))).status).toBe(403)
      expect((await app.request('/v1/sessions/33333333-3333-4333-8333-333333333333/upload-urls', json({ items: [{ seq: 1, kinds: ['depth'] }] }, tokens.user))).status).toBe(403)
    })
  })

  describe('admin cost endpoints (PLAN §3)', () => {
    const adminHeaders = { Authorization: 'Bearer admin-key-1234' }

    it('needs the admin key', async () => {
      for (const path of ['/admin/costs/overview', '/admin/costs/usage', '/admin/costs/pricing', '/admin/costs/projection']) {
        expect((await app.request(path)).status, path).toBe(401)
        expect((await app.request(path, { headers: { Authorization: `Bearer ${tokens.device}` } })).status, path).toBe(403)
        expect((await app.request(path, { headers: { Authorization: `Bearer ${tokens.client}` } })).status, path).toBe(403)
      }
    })

    it('serves the price table without touching the database', async () => {
      const res = await app.request('/admin/costs/pricing', { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.month_days).toBe(30)
      expect(Array.isArray(body.pricing)).toBe(true)
      expect(body.pricing.length).toBeGreaterThan(20)
      for (const entry of body.pricing) {
        expect(entry).toHaveProperty('unit_price_usd')
        expect(entry).toHaveProperty('free_quota')
        expect(entry).toHaveProperty('unit')
        expect(entry).toHaveProperty('as_of')
        expect(entry).toHaveProperty('source')
      }
      expect(Array.isArray(body.unverified_metrics)).toBe(true)
    })

    it('runs the projection from query parameters', async () => {
      const res = await app.request('/admin/costs/projection?mappers=1&sessions_per_day=1&minutes_per_session=5&dashboard_views_per_day=0', { headers: adminHeaders })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.params.mappers).toBe(1)
      expect(body.params.minutes_per_session).toBe(5)
      expect(body.params.keyframes_per_second).toBe(3)     // default kept
      expect(body.grand_total_usd).toBeGreaterThan(0)      // the Apple membership is always billable
      expect(Array.isArray(body.assumptions)).toBe(true)
      expect(body.providers.some((p: { provider: string }) => p.provider === 'gcs')).toBe(true)
    })

    it('validates the projection and window parameters before doing any work', async () => {
      expect((await app.request('/admin/costs/projection?mappers=lots', { headers: adminHeaders })).status).toBe(400)
      expect((await app.request('/admin/costs/projection?mappers=-1', { headers: adminHeaders })).status).toBe(400)
      expect((await app.request('/admin/costs/projection?jpeg_every_n=1.5', { headers: adminHeaders })).status).toBe(400)
      expect((await app.request('/admin/costs/overview?days=0', { headers: adminHeaders })).status).toBe(400)
      expect((await app.request('/admin/costs/usage?days=999', { headers: adminHeaders })).status).toBe(400)
    })
  })

  describe('parties', () => {
    it('refuses the read-only client key and the worker key on join', async () => {
      expect((await app.request('/v1/sessions/join', json({ code: 'ABCD2345' }, tokens.client))).status).toBe(403)
      expect((await app.request('/v1/sessions/join', json({ code: 'ABCD2345' }, 'worker-key-1234'))).status).toBe(403)
      expect((await app.request('/v1/sessions/join', json({ code: 'ABCD2345' }))).status).toBe(401)
    })

    it('rejects a malformed invite code before touching the database', async () => {
      expect((await app.request('/v1/sessions/join', json({ code: 'nope' }, tokens.user))).status).toBe(400)
      const res = await app.request('/v1/sessions/by-code/nope', { headers: { Authorization: `Bearer ${tokens.device}` } })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('bad_request')
    })

    it('requires credentials to look a code up', async () => {
      expect((await app.request('/v1/sessions/by-code/ABCD2345')).status).toBe(401)
    })

    it('requires credentials for a realtime token', async () => {
      expect((await app.request('/v1/realtime/token', json({}))).status).toBe(401)
      expect((await app.request('/v1/realtime/token', json({}, 'worker-key-1234'))).status).toBe(403)
    })
  })
})
