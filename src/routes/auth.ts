import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { db, schema } from '../db/client.js'
import { mintToken, roleForAccessKey } from '../lib/auth.js'
import { AppError } from '../lib/errors.js'
import { tokenRequest } from '../schemas.js'

export const auth = new Hono()

/**
 * Exchange an access key for a JWT. The iOS app sends its device identity and gets a `device` token;
 * the web app gets a `client` token; the admin key gets an `admin` token.
 */
auth.post('/v1/auth/token', zValidator('json', tokenRequest), async (c) => {
  const body = c.req.valid('json')
  const keyRole = roleForAccessKey(body.access_key)
  if (!keyRole) throw new AppError('unauthorized', 'unknown access key')
  if (keyRole === 'client' && body.device) {
    const now = new Date()
    await db().insert(schema.devices).values({ id: body.device.id, name: body.device.name, platform: body.device.platform, lastSeenAt: now })
      .onConflictDoUpdate({ target: schema.devices.id, set: { name: body.device.name, platform: body.device.platform, lastSeenAt: now } })
    const t = await mintToken({ role: 'device', device_id: body.device.id })
    return c.json({ token: t.token, expires_at: t.expiresAt, role: 'device', device_id: body.device.id })
  }
  const t = await mintToken({ role: keyRole })
  return c.json({ token: t.token, expires_at: t.expiresAt, role: keyRole })
})
