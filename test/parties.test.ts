import { describe, expect, it } from 'vitest'
import {
  INVITE_CODE_RE, PARTICIPANT_COLORS, activeIdentities, generateInviteCode, identityKey, isInviteCode,
  joinDecision, matchParticipant, normalizeInviteCode, pickColor, shareUrl, type ParticipantLike,
} from '../src/lib/parties.js'

const device = (deviceId: string, extra: Partial<ParticipantLike> = {}): ParticipantLike => ({ deviceId, userId: null, leftAt: null, color: null, ...extra })
const viewer = (userId: string, extra: Partial<ParticipantLike> = {}): ParticipantLike => ({ deviceId: null, userId, leftAt: null, color: null, ...extra })

describe('invite codes', () => {
  it('are eight uppercase base32 characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode()
      expect(code).toHaveLength(8)
      expect(code).toMatch(INVITE_CODE_RE)
      expect(isInviteCode(code)).toBe(true)
    }
  })

  it('does not repeat itself over a large sample', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(generateInviteCode())
    expect(seen.size).toBe(5000)
  })

  it('normalises what a human types', () => {
    expect(normalizeInviteCode(' abcd-2345 ')).toBe('ABCD2345')
    expect(normalizeInviteCode('abcd 2345')).toBe('ABCD2345')
    expect(isInviteCode('ABCD2345')).toBe(true)
    expect(isInviteCode('ABCD2340')).toBe(false) // 0 and 1 are not base32
    expect(isInviteCode('ABCD234')).toBe(false)
    expect(isInviteCode('abcd2345')).toBe(false) // callers normalise first
  })

  it('builds the dashboard share link', () => {
    expect(shareUrl('https://ghostmap.vercel.app/', 'ABCD2345')).toBe('https://ghostmap.vercel.app/join/ABCD2345')
  })
})

describe('participant colours', () => {
  it('hands out the palette in join order', () => {
    const taken: string[] = []
    for (const expected of PARTICIPANT_COLORS) {
      const next = pickColor(taken)
      expect(next).toBe(expected)
      taken.push(next)
    }
  })

  it('skips colours already held and wraps once all eight are used', () => {
    expect(pickColor([PARTICIPANT_COLORS[0]])).toBe(PARTICIPANT_COLORS[1])
    expect(pickColor([null, undefined, PARTICIPANT_COLORS[0], PARTICIPANT_COLORS[1]])).toBe(PARTICIPANT_COLORS[2])
    expect(PARTICIPANT_COLORS).toContain(pickColor([...PARTICIPANT_COLORS]))
  })
})

describe('the participant cap', () => {
  it('counts an account once however many devices it brings', () => {
    const rows = [
      { deviceId: 'd1', userId: 'u1', leftAt: null },
      { deviceId: 'd2', userId: 'u1', leftAt: null },
      { deviceId: 'd3', userId: null, leftAt: null },
    ]
    expect(activeIdentities(rows)).toEqual(new Set(['user:u1', 'device:d3']))
  })

  it('ignores participants that have left', () => {
    expect(activeIdentities([device('d1', { leftAt: new Date() }), device('d2')])).toEqual(new Set(['device:d2']))
  })

  it('prefers the account over the device when keying an identity', () => {
    expect(identityKey({ userId: 'u1', deviceId: 'd1' })).toBe('user:u1')
    expect(identityKey({ deviceId: 'd1' })).toBe('device:d1')
    expect(identityKey({})).toBeUndefined()
  })

  it('allows a fourth distinct user and refuses a fifth', () => {
    const four = [viewer('u1'), viewer('u2'), viewer('u3'), viewer('u4')]
    const three = four.slice(0, 3)
    expect(joinDecision({ status: 'active', maxParticipants: 4, participants: three, identity: { userId: 'u4' } })).toMatchObject({ ok: true, activeCount: 3 })
    const full = joinDecision({ status: 'active', maxParticipants: 4, participants: four, identity: { userId: 'u5' } })
    expect(full).toMatchObject({ ok: false, reason: 'session_full', activeCount: 4 })
  })

  it('always lets an existing participant rejoin, even at capacity', () => {
    const four = [viewer('u1'), viewer('u2'), viewer('u3'), viewer('u4')]
    expect(joinDecision({ status: 'active', maxParticipants: 4, participants: four, identity: { userId: 'u2' } }))
      .toMatchObject({ ok: true, rejoin: true })
  })

  it('needs capacity again once a participant has left and comes back', () => {
    const rows = [viewer('u1', { leftAt: new Date() }), viewer('u2'), viewer('u3'), viewer('u4'), viewer('u5')]
    expect(joinDecision({ status: 'active', maxParticipants: 4, participants: rows, identity: { userId: 'u1' } }))
      .toMatchObject({ ok: false, reason: 'session_full' })
  })

  it('refuses any join once the party has ended', () => {
    expect(joinDecision({ status: 'ended', maxParticipants: 4, participants: [], identity: { userId: 'u1' } }))
      .toMatchObject({ ok: false, reason: 'session_ended' })
    expect(joinDecision({ status: 'merging', maxParticipants: 4, participants: [viewer('u1')], identity: { userId: 'u1' } }))
      .toMatchObject({ ok: false, reason: 'session_ended' })
  })

  it('honours a smaller max_participants', () => {
    expect(joinDecision({ status: 'active', maxParticipants: 2, participants: [viewer('u1'), viewer('u2')], identity: { userId: 'u3' } }))
      .toMatchObject({ ok: false, reason: 'session_full' })
  })
})

describe('matching a row to an identity', () => {
  const rows = [device('d1', { userId: 'u1', color: '#111111' }), viewer('u2', { color: '#222222' })]

  it('finds a device by its own id, not by its account', () => {
    expect(matchParticipant(rows, { deviceId: 'd1' })?.color).toBe('#111111')
    expect(matchParticipant(rows, { deviceId: 'dX' })).toBeUndefined()
  })

  it('finds a viewer row by account, ignoring device rows of the same account', () => {
    expect(matchParticipant(rows, { userId: 'u2' })?.color).toBe('#222222')
    expect(matchParticipant(rows, { userId: 'u1' })).toBeUndefined()
    expect(matchParticipant(rows, {})).toBeUndefined()
  })
})
