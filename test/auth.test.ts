import { beforeAll, describe, expect, it } from 'vitest'

process.env.AUTH_JWT_SECRET = 'test-secret-test-secret-test-secret'
process.env.ADMIN_API_KEY = 'admin-key-1234'
process.env.CLIENT_ACCESS_KEYS = 'client-key-1234, other-key'
process.env.DATABASE_URL = 'postgres://u:p@localhost/db'
process.env.NODE_ENV = 'test'

describe('auth', () => {
  let mod: typeof import('../src/lib/auth.js')
  beforeAll(async () => { mod = await import('../src/lib/auth.js') })

  it('maps access keys to roles', () => {
    expect(mod.roleForAccessKey('admin-key-1234')).toBe('admin')
    expect(mod.roleForAccessKey('client-key-1234')).toBe('client')
    expect(mod.roleForAccessKey('other-key')).toBe('client')
    expect(mod.roleForAccessKey('nope')).toBeUndefined()
  })

  it('mints and verifies device tokens', async () => {
    const { token, expiresAt } = await mod.mintToken({ role: 'device', device_id: '11111111-1111-4111-8111-111111111111' })
    const p = await mod.verifyToken(token)
    expect(p.role).toBe('device')
    expect(p.deviceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400 * 1000)
  })

  it('rejects tampered tokens', async () => {
    const { token } = await mod.mintToken({ role: 'client' })
    await expect(mod.verifyToken(token.slice(0, -2) + 'xx')).rejects.toThrow()
  })
})
