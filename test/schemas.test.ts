import { describe, expect, it } from 'vitest'
import { keyframeIn, originSchema, createMap } from '../src/schemas.js'

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

  it('defaults map files and origin', () => {
    const r = createMap.parse({ name: 'Living room' })
    expect(r.origin.type).toBe('session-start')
    expect(r.files).toContain('cloud.ply')
  })
})
