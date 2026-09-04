import { describe, expect, it } from 'vitest'
import { canEndSession, canReadMap, canReadSession, canWriteMap, ownsMap, ownsSession } from '../src/lib/access.js'
import type { Principal } from '../src/lib/auth.js'

const admin: Principal = { role: 'admin', via: 'api_key' }
const client: Principal = { role: 'client', via: 'jwt' }
const alice: Principal = { role: 'user', userId: 'u-alice', via: 'jwt' }
const bob: Principal = { role: 'user', userId: 'u-bob', via: 'jwt' }
const alicePhone: Principal = { role: 'device', deviceId: 'd-alice', userId: 'u-alice', via: 'jwt' }
const legacyPhone: Principal = { role: 'device', deviceId: 'd-legacy', via: 'jwt' }

const map = (o: Partial<{ ownerUserId: string | null; deviceId: string | null; sessionId: string | null }> = {}) =>
  ({ ownerUserId: null, deviceId: null, sessionId: null, ...o })

describe('map ownership', () => {
  it('binds a map to its owning account first, its device second', () => {
    expect(ownsMap(alice, map({ ownerUserId: 'u-alice' }))).toBe(true)
    expect(ownsMap(bob, map({ ownerUserId: 'u-alice' }))).toBe(false)
    expect(ownsMap(alicePhone, map({ ownerUserId: 'u-alice', deviceId: 'd-other' }))).toBe(true)
    expect(ownsMap(legacyPhone, map({ deviceId: 'd-legacy' }))).toBe(true)
    expect(ownsMap(legacyPhone, map({ deviceId: 'd-other' }))).toBe(false)
  })

  it('leaves pre-accounts rows open so legacy clients keep working', () => {
    expect(ownsMap(legacyPhone, map())).toBe(true)
    expect(ownsMap(alice, map())).toBe(true)
  })

  it('never lets the read-only client key write', () => {
    expect(canWriteMap(client, map())).toBe(false)
    expect(canWriteMap(client, map({ ownerUserId: 'u-alice' }))).toBe(false)
    expect(canWriteMap(admin, map({ ownerUserId: 'u-alice' }))).toBe(true)
    expect(canWriteMap(bob, map({ ownerUserId: 'u-alice' }))).toBe(false)
  })
})

describe('map visibility', () => {
  it('shows admins and the legacy client key everything', () => {
    expect(canReadMap(admin, map({ ownerUserId: 'u-alice' }), [])).toBe(true)
    expect(canReadMap(client, map({ ownerUserId: 'u-alice' }), [])).toBe(true)
  })

  it('shows a map from a party the caller took part in', () => {
    const m = map({ ownerUserId: 'u-alice', sessionId: 's1' })
    expect(canReadMap(bob, m, ['s1'])).toBe(true)
    expect(canReadMap(bob, m, ['s2'])).toBe(false)
  })
})

describe('session ownership', () => {
  const session = (o: Partial<{ ownerUserId: string | null; leaderDeviceId: string | null }> = {}) =>
    ({ ownerUserId: null, leaderDeviceId: null, ...o })

  it('recognises the owner account and the leader device', () => {
    expect(ownsSession(alice, session({ ownerUserId: 'u-alice' }))).toBe(true)
    expect(ownsSession(legacyPhone, session({ leaderDeviceId: 'd-legacy' }))).toBe(true)
    expect(ownsSession(bob, session({ ownerUserId: 'u-alice' }))).toBe(false)
    expect(ownsSession(bob, session())).toBe(false)
  })

  it('lets only owner, leader and admin end a party', () => {
    expect(canEndSession(admin, session({ ownerUserId: 'u-alice' }))).toBe(true)
    expect(canEndSession(bob, session({ ownerUserId: 'u-alice' }))).toBe(false)
  })

  it('lets participants read a party they do not own', () => {
    expect(canReadSession(bob, session({ ownerUserId: 'u-alice' }), true)).toBe(true)
    expect(canReadSession(bob, session({ ownerUserId: 'u-alice' }), false)).toBe(false)
    expect(canReadSession(client, session({ ownerUserId: 'u-alice' }), false)).toBe(true)
  })
})
