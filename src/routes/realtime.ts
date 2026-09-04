import { Hono } from 'hono'
import { zValidator } from '../lib/validate.js'
import { and, eq, isNull, or, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth, type Principal } from '../lib/auth.js'
import { createTokenRequest, sessionChannel } from '../lib/ably.js'
import { forbidden } from '../lib/errors.js'
import { realtimeToken } from '../schemas.js'

export const realtime = new Hono()

const sp = schema.sessionParticipants

function participantMatchesPrincipal(p: Principal): SQL | undefined {
  const parts: SQL[] = []
  if (p.deviceId) parts.push(eq(sp.deviceId, p.deviceId))
  if (p.userId) parts.push(eq(sp.userId, p.userId))
  return parts.length ? or(...parts) : undefined
}

/**
 * Ably TokenRequest. Feed it to the Ably SDK's `authCallback`; the SDK exchanges it for a token.
 * Active participants of the session — mapper devices and signed-in viewers alike — get
 * publish/subscribe/presence/history on that channel; anyone else asking for a session is refused (403).
 * The legacy read-only `client` key keeps its subscribe-only token so existing viewers keep working.
 */
realtime.post('/v1/realtime/token', requireAuth('device', 'client', 'user'), zValidator('json', realtimeToken), async (c) => {
  const p = c.get('principal')
  const { session_id } = c.req.valid('json')
  let publish = false
  if (session_id && p.role !== 'admin' && p.role !== 'client') {
    const mine = participantMatchesPrincipal(p)
    const [row] = mine
      ? await db().select({ kind: sp.kind }).from(sp).where(and(eq(sp.sessionId, session_id), mine, isNull(sp.leftAt))).limit(1)
      : []
    if (!row) throw forbidden('not an active participant of this party')
    publish = true
  }
  const clientId = p.deviceId ?? (p.userId ? `user-${p.userId}` : `${p.role}-${crypto.randomUUID().slice(0, 8)}`)
  const tokenRequest = await createTokenRequest({ clientId, sessionId: session_id, publish, admin: p.role === 'admin' })
  return c.json({ token_request: tokenRequest, channel: session_id ? sessionChannel(session_id) : undefined, can_publish: publish || p.role === 'admin' })
})
