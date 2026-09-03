import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth } from '../lib/auth.js'
import { createTokenRequest } from '../lib/ably.js'
import { realtimeToken } from '../schemas.js'

export const realtime = new Hono()

/**
 * Ably TokenRequest. Feed it to the Ably SDK's `authCallback`; the SDK exchanges it for a token.
 * Devices that participate in `session_id` may publish; everyone else may only subscribe.
 */
realtime.post('/v1/realtime/token', requireAuth('device', 'client'), zValidator('json', realtimeToken), async (c) => {
  const p = c.get('principal')
  const { session_id } = c.req.valid('json')
  let publish = false
  if (session_id && p.role === 'device' && p.deviceId) {
    const [row] = await db().select().from(schema.sessionParticipants)
      .where(and(eq(schema.sessionParticipants.sessionId, session_id), eq(schema.sessionParticipants.deviceId, p.deviceId), isNull(schema.sessionParticipants.leftAt))).limit(1)
    publish = Boolean(row)
  }
  const clientId = p.deviceId ?? `${p.role}-${crypto.randomUUID().slice(0, 8)}`
  const tokenRequest = await createTokenRequest({ clientId, sessionId: session_id, publish, admin: p.role === 'admin' })
  return c.json({ token_request: tokenRequest, channel: session_id ? `session:${session_id}` : undefined, can_publish: publish || p.role === 'admin' })
})
