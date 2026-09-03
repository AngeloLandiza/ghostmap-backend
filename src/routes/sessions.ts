import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth, type Principal } from '../lib/auth.js'
import { isAblyConfigured, publish } from '../lib/ably.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { keyframeContentType, keyframeObjectPath, signDownload, signUpload, type KeyframeKind } from '../lib/gcs.js'
import { newId } from '../lib/ids.js'
import { createSession, keyframeQuery, keyframeUploadUrls, listQuery, registerKeyframes } from '../schemas.js'

export const sessions = new Hono()

async function loadSession(id: string) {
  const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1)
  if (!row) throw notFound('session')
  return row
}

async function participants(sessionId: string) {
  return db().select().from(schema.sessionParticipants).where(eq(schema.sessionParticipants.sessionId, sessionId)).orderBy(asc(schema.sessionParticipants.joinedAt))
}

/** Devices must be active participants to write; admins always may. */
async function assertParticipant(p: Principal, sessionId: string) {
  if (p.role === 'admin') return
  if (p.role !== 'device' || !p.deviceId) throw forbidden('only devices can write to a session')
  const [row] = await db().select().from(schema.sessionParticipants)
    .where(and(eq(schema.sessionParticipants.sessionId, sessionId), eq(schema.sessionParticipants.deviceId, p.deviceId), isNull(schema.sessionParticipants.leftAt))).limit(1)
  if (!row) throw forbidden('device is not a participant of this session')
}

sessions.post('/v1/sessions', requireAuth('device'), zValidator('json', createSession), async (c) => {
  const p = c.get('principal')
  const body = c.req.valid('json')
  if (body.base_map_id) {
    const [base] = await db().select().from(schema.maps).where(eq(schema.maps.id, body.base_map_id)).limit(1)
    if (!base) throw notFound('base map')
  }
  const id = newId()
  const [row] = await db().insert(schema.sessions).values({
    id, name: body.name, origin: body.origin, leaderDeviceId: p.deviceId ?? null, baseMapId: body.base_map_id ?? null, status: 'active',
  }).returning()
  if (p.deviceId) await db().insert(schema.sessionParticipants).values({ sessionId: id, deviceId: p.deviceId, role: 'leader' })
  return c.json({ session: row, participants: await participants(id), channel: `session:${id}` }, 201)
})

sessions.get('/v1/sessions', requireAuth('device', 'client'), zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query')
  const conds = q.status ? [eq(schema.sessions.status, q.status)] : []
  const rows = await db().select().from(schema.sessions).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.sessions.createdAt)).limit(q.limit)
  return c.json({ sessions: rows })
})

sessions.get('/v1/sessions/:id', requireAuth('device', 'client'), async (c) => {
  const row = await loadSession(c.req.param('id'))
  return c.json({ session: row, participants: await participants(row.id), channel: `session:${row.id}` })
})

sessions.post('/v1/sessions/:id/join', requireAuth('device'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  if (row.status !== 'active') throw badRequest(`session is ${row.status}`)
  if (!p.deviceId) throw forbidden('device token required')
  await db().insert(schema.sessionParticipants).values({ sessionId: row.id, deviceId: p.deviceId, role: 'member' })
    .onConflictDoUpdate({ target: [schema.sessionParticipants.sessionId, schema.sessionParticipants.deviceId], set: { leftAt: null, joinedAt: new Date() } })
  if (isAblyConfigured()) await publish(row.id, 'participant', { event: 'joined', device_id: p.deviceId }).catch(() => undefined)
  return c.json({ session: row, participants: await participants(row.id), channel: `session:${row.id}` })
})

sessions.post('/v1/sessions/:id/leave', requireAuth('device'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  if (!p.deviceId) throw forbidden('device token required')
  await db().update(schema.sessionParticipants).set({ leftAt: new Date() })
    .where(and(eq(schema.sessionParticipants.sessionId, row.id), eq(schema.sessionParticipants.deviceId, p.deviceId)))
  if (isAblyConfigured()) await publish(row.id, 'participant', { event: 'left', device_id: p.deviceId }).catch(() => undefined)
  return c.json({ left: true })
})

/** Leader (or admin) ends the session; merging is requested separately via POST /v1/sessions/:id/merge. */
sessions.post('/v1/sessions/:id/end', requireAuth('device'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  if (p.role !== 'admin' && row.leaderDeviceId !== p.deviceId) throw forbidden('only the session leader can end it')
  const [updated] = await db().update(schema.sessions).set({ status: 'ended', endedAt: new Date() }).where(eq(schema.sessions.id, row.id)).returning()
  if (isAblyConfigured()) await publish(row.id, 'session', { event: 'ended' }).catch(() => undefined)
  return c.json({ session: updated })
})

/** Batch of signed PUT URLs for keyframe blobs (depth / confidence / jpeg / mesh). */
sessions.post('/v1/sessions/:id/upload-urls', requireAuth('device'), zValidator('json', keyframeUploadUrls), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  await assertParticipant(p, row.id)
  const deviceId = p.deviceId ?? 'admin'
  const uploads = []
  for (const item of c.req.valid('json').items) {
    for (const kind of item.kinds as KeyframeKind[]) {
      const path = keyframeObjectPath(row.id, deviceId, item.seq, kind)
      uploads.push({ seq: item.seq, kind, ...(await signUpload(path, keyframeContentType(kind), { ttlSeconds: 30 * 60 })) })
    }
  }
  return c.json({ uploads })
})

/** Register keyframes (after their blobs are in GCS) and fan them out to the realtime channel. */
sessions.post('/v1/sessions/:id/keyframes', requireAuth('device'), zValidator('json', registerKeyframes), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  if (row.status !== 'active') throw badRequest(`session is ${row.status}`)
  await assertParticipant(p, row.id)
  const deviceId = p.deviceId
  if (!deviceId) throw forbidden('device token required')
  const items = c.req.valid('json').keyframes
  const values = items.map((k) => ({
    sessionId: row.id, deviceId, seq: k.seq, t: k.t, pose: k.pose, intrinsics: k.intrinsics,
    trackingState: k.tracking_state, worldMappingStatus: k.world_mapping_status,
    depthRef: k.depth_ref ?? keyframeObjectPath(row.id, deviceId, k.seq, 'depth'),
    confidenceRef: k.confidence_ref ?? keyframeObjectPath(row.id, deviceId, k.seq, 'confidence'),
    jpegRef: k.jpeg_ref ?? null, meshRef: k.mesh_ref ?? null, pointsInline: k.points_inline ?? null, bytes: k.bytes,
  }))
  const inserted = await db().insert(schema.keyframes).values(values)
    .onConflictDoUpdate({ target: [schema.keyframes.sessionId, schema.keyframes.deviceId, schema.keyframes.seq], set: { t: sql`excluded.t`, pose: sql`excluded.pose`, pointsInline: sql`excluded.points_inline`, bytes: sql`excluded.bytes` } })
    .returning({ id: schema.keyframes.id, seq: schema.keyframes.seq })
  const bytes = values.reduce((s, v) => s + v.bytes, 0)
  await db().update(schema.sessions).set({ keyframeCount: sql`${schema.sessions.keyframeCount} + ${values.length}`, bytes: sql`${schema.sessions.bytes} + ${bytes}` }).where(eq(schema.sessions.id, row.id))
  if (isAblyConfigured()) {
    // Live viewers get pose + intrinsics + inline points; blobs stay in GCS and are referenced by path.
    await publish(row.id, 'keyframes', {
      device_id: deviceId,
      keyframes: items.map((k) => ({ seq: k.seq, t: k.t, pose: k.pose, intrinsics: k.intrinsics, tracking_state: k.tracking_state, depth_ref: keyframeObjectPath(row.id, deviceId, k.seq, 'depth'), points_inline: k.points_inline ?? null })),
    }).catch((e) => console.error('ably publish failed', e))
  }
  return c.json({ registered: inserted }, 201)
})

/** Catch-up for viewers: keyframes after `since_id`, optionally with signed download URLs. */
sessions.get('/v1/sessions/:id/keyframes', requireAuth('device', 'client'), zValidator('query', keyframeQuery), async (c) => {
  const row = await loadSession(c.req.param('id'))
  const q = c.req.valid('query')
  const conds = [eq(schema.keyframes.sessionId, row.id), gt(schema.keyframes.id, q.since_id)]
  if (q.device_id) conds.push(eq(schema.keyframes.deviceId, q.device_id))
  const rows = await db().select().from(schema.keyframes).where(and(...conds)).orderBy(asc(schema.keyframes.id)).limit(q.limit)
  const out = []
  for (const k of rows) {
    const urls = q.urls ? {
      depth: k.depthRef ? (await signDownload(k.depthRef)).url : undefined,
      confidence: k.confidenceRef ? (await signDownload(k.confidenceRef)).url : undefined,
      jpeg: k.jpegRef ? (await signDownload(k.jpegRef)).url : undefined,
      mesh: k.meshRef ? (await signDownload(k.meshRef)).url : undefined,
    } : undefined
    out.push({ ...k, urls })
  }
  return c.json({ keyframes: out, next_since_id: rows.length ? rows[rows.length - 1]?.id : q.since_id })
})
