import { describe, expect, it } from 'vitest'
import { createMap, createSession, googleSignIn, inviteCode, joinSession, keyframeIn, originSchema } from '../src/schemas.js'

describe('schemas', () => {
  it('requires marker_id for marker origins', () => {
    expect(originSchema.safeParse({ type: 'marker' }).success).toBe(false)
    expect(originSchema.safeParse({ type: 'marker', marker_id: 'tag36h11_0' }).success).toBe(true)
    expect(originSchema.safeParse({ type: 'session-start' }).success).toBe(true)
  })

  it('validates keyframes (16-float pose, inline point cap)', () => {
    const base = { seq: 1, t: 1.5, pose: Array(16).fill(0), intrinsics: { fx: 1, fy: 1, cx: 1, cy: 1, w: 256, h: 192 } }
    expect(keyframeIn.safeParse(base).success).toBe(true)
    expect(keyframeIn.safeParse({ ...base, pose: Array(15).fill(0) }).success).toBe(false)
    expect(keyframeIn.safeParse({ ...base, points_inline: Array(2000 * 6 + 1).fill(0) }).success).toBe(false)
  })

  it('treats a keyframe as aligned unless it says otherwise', () => {
    const base = { seq: 1, t: 1.5, pose: Array(16).fill(0), intrinsics: { fx: 1, fy: 1, cx: 1, cy: 1, w: 256, h: 192 } }
    expect(keyframeIn.parse(base).aligned).toBe(true)
    expect(keyframeIn.parse({ ...base, aligned: false }).aligned).toBe(false)
    expect(keyframeIn.safeParse({ ...base, aligned: 'yes' }).success).toBe(false)
  })

  it('defaults map files and origin', () => {
    const r = createMap.parse({ name: 'Living room' })
    expect(r.origin.type).toBe('session-start')
    expect(r.files).toContain('cloud.ply')
  })

  it('caps a party at eight seats and defaults to four', () => {
    expect(createSession.parse({ name: 'Kitchen' }).max_participants).toBe(4)
    expect(createSession.parse({ name: 'Kitchen', max_participants: 2 }).max_participants).toBe(2)
    expect(createSession.safeParse({ name: 'Kitchen', max_participants: 9 }).success).toBe(false)
    expect(createSession.safeParse({ name: 'Kitchen', max_participants: 0 }).success).toBe(false)
  })

  it('accepts invite codes the way a human types them', () => {
    expect(inviteCode.parse(' abcd-2345 ')).toBe('ABCD2345')
    expect(inviteCode.safeParse('ABCD2340').success).toBe(false)
    expect(inviteCode.safeParse('SHORT').success).toBe(false)
    expect(inviteCode.safeParse(12345678).success).toBe(false)
  })

  it('validates a join body', () => {
    expect(joinSession.parse({ code: 'abcd2345' })).toEqual({ code: 'ABCD2345' })
    expect(joinSession.parse({ code: 'ABCD2345', kind: 'viewer' }).kind).toBe('viewer')
    expect(joinSession.safeParse({ code: 'ABCD2345', kind: 'ghost' }).success).toBe(false)
    expect(joinSession.safeParse({}).success).toBe(false)
  })

  it('requires an id token for Google sign-in and defaults the device platform', () => {
    expect(googleSignIn.safeParse({ id_token: 'short' }).success).toBe(false)
    const parsed = googleSignIn.parse({ id_token: 'x'.repeat(40), device: { id: '11111111-1111-4111-8111-111111111111' } })
    expect(parsed.device?.platform).toBe('ios')
    expect(googleSignIn.safeParse({ id_token: 'x'.repeat(40), device: { id: 'not-a-uuid' } }).success).toBe(false)
  })
})
