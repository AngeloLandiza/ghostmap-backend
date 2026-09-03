import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth } from '../lib/auth.js'
import { notFound } from '../lib/errors.js'

export const devices = new Hono()

devices.get('/v1/devices/me', requireAuth('device'), async (c) => {
  const p = c.get('principal')
  if (!p.deviceId) return c.json({ role: p.role })
  const [row] = await db().select().from(schema.devices).where(eq(schema.devices.id, p.deviceId)).limit(1)
  if (!row) throw notFound('device')
  return c.json({ device: row, role: p.role })
})

devices.get('/v1/devices', requireAuth('admin'), async (c) => {
  const rows = await db().select().from(schema.devices).orderBy(desc(schema.devices.lastSeenAt)).limit(500)
  return c.json({ devices: rows })
})
