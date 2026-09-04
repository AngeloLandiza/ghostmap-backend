import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { mintToken, requireAuth, roleForAccessKey } from '../lib/auth.js'
import { AppError, notFound } from '../lib/errors.js'
import { verifyGoogleIdToken } from '../lib/google.js'
import { newId } from '../lib/ids.js'
import { googleSignIn, tokenRequest } from '../schemas.js'

export const auth = new Hono()

type UserRow = typeof schema.users.$inferSelect

const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, picture_url: u.pictureUrl, created_at: u.createdAt })

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

/**
 * Google sign-in. Verifies the id token against `GOOGLE_CLIENT_IDS`, upserts the account, and returns
 * a `device` token (30 days) when the caller sends its device identity, otherwise a `user` token (7 days).
 */
auth.post('/v1/auth/google', zValidator('json', googleSignIn), async (c) => {
  const body = c.req.valid('json')
  const identity = await verifyGoogleIdToken(body.id_token)
  const now = new Date()
  const [user] = await db().insert(schema.users)
    .values({ id: newId(), googleSub: identity.sub, email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl, lastLoginAt: now })
    .onConflictDoUpdate({
      target: schema.users.googleSub,
      set: { email: identity.email, name: identity.name, pictureUrl: identity.pictureUrl, lastLoginAt: now },
    })
    .returning()
  if (!user) throw new AppError('internal', 'could not upsert the user record')

  if (body.device) {
    await db().insert(schema.devices)
      .values({ id: body.device.id, userId: user.id, name: body.device.name, platform: body.device.platform, lastSeenAt: now })
      .onConflictDoUpdate({ target: schema.devices.id, set: { userId: user.id, name: body.device.name, platform: body.device.platform, lastSeenAt: now } })
    const t = await mintToken({ role: 'device', device_id: body.device.id, user_id: user.id, email: user.email })
    return c.json({ token: t.token, expires_at: t.expiresAt, role: 'device', device_id: body.device.id, user: publicUser(user) })
  }
  const t = await mintToken({ role: 'user', user_id: user.id, email: user.email })
  return c.json({ token: t.token, expires_at: t.expiresAt, role: 'user', user: publicUser(user) })
})

/** Who the bearer token belongs to. Any authenticated role may call it. */
auth.get('/v1/auth/me', requireAuth(), async (c) => {
  const p = c.get('principal')
  const out: Record<string, unknown> = { role: p.role, device_id: p.deviceId ?? null, user: null }
  if (p.userId) {
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, p.userId)).limit(1)
    if (!row) throw notFound('user')
    out.user = publicUser(row)
  }
  return c.json(out)
})
