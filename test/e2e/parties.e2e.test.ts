import { afterAll, describe, expect, it } from 'vitest'
import { E2E_ENABLED, get, mintDeviceToken, post, registerCleanup, runCleanups } from './helpers.js'

const pose = () => Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 1 : 0))
const intrinsics = { fx: 1000, fy: 1000, cx: 320, cy: 240, w: 640, h: 480 }

describe.skipIf(!E2E_ENABLED)('E2E: parties', () => {
  afterAll(runCleanups)

  it('create -> by-code -> join cap of 4 -> 409 on the 5th -> leave/rejoin -> keyframes -> realtime -> end -> 410', async () => {
    const devices = await Promise.all(
      ['party-a', 'party-b', 'party-c', 'party-d', 'party-e'].map((label) => mintDeviceToken(label)),
    )
    const [a, b, c, d, e] = devices
    if (!a || !b || !c || !d || !e) throw new Error('expected 5 minted devices')

    // --- create by device A. A device creator is auto-added as the leader participant (PLAN §2). ---
    const created = await post('/v1/sessions', { name: `E2E party ${Date.now()}` }, a.token)
    expect(created.status).toBe(201)
    const sessionId = created.body.session.id as string
    const code = created.body.session.inviteCode as string
    expect(code).toMatch(/^[A-Z2-7]{8}$/)
    expect(created.body.participants).toHaveLength(1)
    expect(created.body.share_url).toContain(code)
    registerCleanup(async () => { await post(`/v1/sessions/${sessionId}/end`, {}, a.token) })

    // --- by-code lookup: any authenticated role, before joining ---
    const looked = await get(`/v1/sessions/by-code/${code}`, b.token)
    expect(looked.status).toBe(200)
    expect(looked.body.session.id).toBe(sessionId)
    expect(looked.body.session.participant_count).toBe(1)
    expect(looked.body.can_join).toBe(true)

    // --- join by devices B, C, D: three legacy devices with no account, each counts on its own ---
    for (const dev of [b, c]) {
      const joined = await post('/v1/sessions/join', { code }, dev.token)
      expect(joined.status).toBe(200)
      expect(joined.body.me.kind).toBe('device')
    }
    const joinedD = await post('/v1/sessions/join', { code }, d.token)
    expect(joinedD.status).toBe(200)
    const dColor = joinedD.body.me.color as string
    expect(typeof dColor).toBe('string')

    // A, B, C, D are now four distinct active devices — exactly at the default cap of 4.
    const full = await get(`/v1/sessions/${sessionId}`, a.token)
    expect(full.status).toBe(200)
    expect(full.body.participants.filter((p: { left_at: string | null }) => !p.left_at)).toHaveLength(4)

    // --- device E gets 409 session_full ---
    const refused = await post('/v1/sessions/join', { code }, e.token)
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('session_full')

    // --- leave + rejoin keeps the same colour ---
    const left = await post(`/v1/sessions/${sessionId}/leave`, {}, d.token)
    expect(left.status).toBe(200)
    expect(left.body.participants.find((p: { device_id: string }) => p.device_id === d.device_id)?.left_at).toBeTruthy()

    const rejoined = await post('/v1/sessions/join', { code }, d.token)
    expect(rejoined.status).toBe(200)
    expect(rejoined.body.me.color).toBe(dColor)

    // --- keyframes register with points_inline and an aligned flag ---
    const registerBody = {
      keyframes: [
        { seq: 0, t: 0, pose: pose(), intrinsics, aligned: true, points_inline: [0, 0, 0, 255, 255, 255, 1, 1, 1, 10, 20, 30] },
        { seq: 1, t: 0.1, pose: pose(), intrinsics, aligned: false, points_inline: [2, 2, 2, 5, 5, 5] },
      ],
    }
    const registered = await post(`/v1/sessions/${sessionId}/keyframes`, registerBody, b.token)
    expect(registered.status).toBe(201)
    expect(registered.body.registered).toHaveLength(2)

    // --- GET keyframes?since_id catches both up, with points_inline and aligned intact ---
    const page = await get(`/v1/sessions/${sessionId}/keyframes?since_id=0`, a.token)
    expect(page.status).toBe(200)
    expect(page.body.keyframes.length).toBeGreaterThanOrEqual(2)
    const bySeq = Object.fromEntries(page.body.keyframes.map((k: { seq: number }) => [k.seq, k]))
    expect(bySeq[0].aligned).toBe(true)
    expect(bySeq[0].pointsInline).toEqual(registerBody.keyframes[0]?.points_inline)
    expect(bySeq[1].aligned).toBe(false)
    expect(typeof page.body.next_since_id).toBe('number')

    // Catch-up from the last seen id returns nothing new.
    const caughtUp = await get(`/v1/sessions/${sessionId}/keyframes?since_id=${page.body.next_since_id}`, a.token)
    expect(caughtUp.body.keyframes).toHaveLength(0)

    // --- realtime token has publish capability for an active participant ---
    const rt = await post('/v1/realtime/token', { session_id: sessionId }, b.token)
    if (rt.status === 501) {
      // Ably is not configured on this deployment; the join/keyframe flow above still proves the rest.
      console.warn('E2E: ABLY_API_KEY not configured on this deployment — skipping the publish-capability assertion')
    } else {
      expect(rt.status).toBe(200)
      expect(rt.body.can_publish).toBe(true)
      expect(rt.body.token_request).toBeTruthy()
      expect(rt.body.channel).toBe(`session:${sessionId}`)
    }
    // A non-participant is refused before Ably is ever consulted, regardless of whether it is configured.
    const rtRefused = await post('/v1/realtime/token', { session_id: sessionId }, e.token)
    expect(rtRefused.status).toBe(403)

    // --- end the party, then a join attempt gets 410 session_ended ---
    const ended = await post(`/v1/sessions/${sessionId}/end`, {}, a.token)
    expect(ended.status).toBe(200)
    expect(ended.body.session.status).toBe('ended')

    const joinEnded = await post('/v1/sessions/join', { code }, e.token)
    expect(joinEnded.status).toBe(410)
    expect(joinEnded.body.error.code).toBe('session_ended')
  })
})
