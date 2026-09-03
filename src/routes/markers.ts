import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { asc } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth } from '../lib/auth.js'
import { createMarker } from '../schemas.js'

export const markers = new Hono()

/** Printed fiducial markers shared as coordinate origins (MVP plan §2, "option b"). */
markers.get('/v1/markers', requireAuth('device', 'client'), async (c) => {
  return c.json({ markers: await db().select().from(schema.markers).orderBy(asc(schema.markers.id)) })
})

markers.post('/v1/markers', requireAuth('admin'), zValidator('json', createMarker), async (c) => {
  const b = c.req.valid('json')
  const [row] = await db().insert(schema.markers).values({ id: b.id, family: b.family, sizeM: b.size_m, description: b.description })
    .onConflictDoUpdate({ target: schema.markers.id, set: { family: b.family, sizeM: b.size_m, description: b.description } }).returning()
  return c.json({ marker: row }, 201)
})
