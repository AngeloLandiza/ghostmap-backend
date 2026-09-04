import { describe, expect, it } from 'vitest'
import { E2E_ENABLED, get, mintDeviceToken, post } from './helpers.js'

describe.skipIf(!E2E_ENABLED)('E2E: token minting', () => {
  it('mints a distinct device token for 5 synthetic devices and each round-trips through /v1/auth/me', async () => {
    const labels = ['auth-a', 'auth-b', 'auth-c', 'auth-d', 'auth-e']
    const devices = await Promise.all(labels.map((label) => mintDeviceToken(label)))

    // distinct devices, distinct tokens
    expect(new Set(devices.map((d) => d.device_id)).size).toBe(5)
    expect(new Set(devices.map((d) => d.token)).size).toBe(5)

    for (const d of devices) {
      expect(d.token.split('.')).toHaveLength(3) // a JWT
      const me = await get('/v1/auth/me', d.token)
      expect(me.status).toBe(200)
      expect(me.body).toMatchObject({ role: 'device', device_id: d.device_id })
    }
  })

  it('rejects an unknown access key', async () => {
    const res = await post('/v1/auth/token', { access_key: 'not-a-real-access-key' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('unauthorized')
  })

  it('rejects a malformed body before touching any credential', async () => {
    // zValidator answers this one directly (its own error shape, not src/lib/errors.ts's), so only the
    // status is part of the contract here.
    const res = await post('/v1/auth/token', {})
    expect(res.status).toBe(400)
  })

  it('demands credentials for /v1/auth/me', async () => {
    const res = await get('/v1/auth/me')
    expect(res.status).toBe(401)
  })
})
