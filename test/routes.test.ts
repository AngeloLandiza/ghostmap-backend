import { beforeAll, describe, expect, it } from 'vitest'

process.env.AUTH_JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.ADMIN_API_KEY = 'admin-key-1234'
process.env.CLIENT_ACCESS_KEYS = 'client-key-1234'
process.env.DATABASE_URL = 'postgres://u:p@localhost/db'
process.env.NODE_ENV = 'test'

describe('routes (no database needed)', () => {
  let app: typeof import('../src/app.js')['app']
  beforeAll(async () => { app = (await import('../src/app.js')).app })

  it('serves health without auth', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('rejects admin routes without credentials', async () => {
    const res = await app.request('/admin/network')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
  })

  it('forbids client tokens on device-only routes', async () => {
    const { mintToken } = await import('../src/lib/auth.js')
    const { token } = await mintToken({ role: 'client' })
    const res = await app.request('/v1/maps', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    expect(res.status).toBe(403)
  })

  it('validates JSON bodies', async () => {
    const res = await app.request('/v1/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    expect(res.status).toBe(400)
  })

  it('rejects unknown access keys', async () => {
    const res = await app.request('/v1/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_key: 'not-a-key' }) })
    expect(res.status).toBe(401)
  })
})
