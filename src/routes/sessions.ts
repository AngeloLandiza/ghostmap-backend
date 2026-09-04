import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, exists, gt, isNull, or, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth, type Principal } from '../lib/auth.js'
import { canEndSession, canReadSession } from '../lib/access.js'
import { isAblyConfigured, createTokenRequest, publish, sessionChannel } from '../lib/ably.js'
import { AppError, badRequest, forbidden, notFound, sessionEnded, sessionFull } from '../lib/errors.js'
import { keyframeContentType, keyframeObjectPath, signDownload, signUpload, type KeyframeKind } from '../lib/gcs.js'
import { newId } from '../lib/ids.js'
import {
  generateInviteCode, isInviteCode, joinDecision, matchParticipant, normalizeInviteCode, pickColor, shareUrl,
  type Identity, type ParticipantKind,
} from '../lib/parties.js'
import { dashboardUrl } from '../env.js'
import { createSession, joinSession, joinSessionById, keyframeQuery, keyframeUploadUrls, listQuery, registerKeyframes } from '../schemas.js'

export const sessions = new Hono()

type SessionRow = typeof schema.sessions.$inferSelect
type ParticipantRow = typeof schema.sessionParticipants.$inferSelect

const sp = schema.sessionParticipants

/** Participants are serialised explicitly so the realtime payloads and the REST rows agree (PLAN §2). */
const publicParticipant = (r: ParticipantRow) => ({
  id: r.id,
  session_id: r.sessionId,
  device_id: r.deviceId,
  user_id: r.userId,
  kind: r.kind,
  color: r.color,
  display_name: r.displayName,
  role: r.role,
  joined_at: r.joinedAt,
  left_at: r.leftAt,
})

async function loadSession(id: string): Promise<SessionRow> {
  const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1)
  if (!row) throw notFound('session')
  return row
}

async function participants(sessionId: string): Promise<ParticipantRow[]> {
  return db().select().from(sp).where(eq(sp.sessionId, sessionId)).orderBy(asc(sp.joinedAt))
}

const shareUrlFor = (row: SessionRow): string | null => (row.inviteCode ? shareUrl(dashboardUrl(), row.inviteCode) : null)

/** A signed-in account counts once however many devices it brings; a device with no account counts alone. */
const identityOf = (p: Principal): Identity => ({ deviceId: p.deviceId ?? null, userId: p.userId ?? null })

/**
 * The row a caller owns in a party. A phone always occupies its own device row — `kind` records whether
 * it is mapping or watching — while a browser session occupies its account's viewer row.
 */
const rowIdentityOf = (p: Principal): Identity => (p.deviceId ? { deviceId: p.deviceId } : { userId: p.userId ?? null })

/** SQL for "this participant row belongs to the caller" (by device or by account). */
function participantMatchesPrincipal(p: Principal): SQL | undefined {
  const parts: SQL[] = []
  if (p.deviceId) parts.push(eq(sp.deviceId, p.deviceId))
  if (p.userId) parts.push(eq(sp.userId, p.userId))
  return parts.length ? or(...parts) : undefined
}

/** Membership for reads: someone who has left a party can still look at what was captured. */
async function isParticipantOf(p: Principal, sessionId: string): Promise<boolean> {
  const mine = participantMatchesPrincipal(p)
  if (!mine) return false
  const [row] = await db().select({ id: sp.id }).from(sp).where(and(eq(sp.sessionId, sessionId), mine)).limit(1)
  return Boolean(row)
}

/** Keyframe writes stay device-only; admins always pass. */
async function assertParticipant(p: Principal, sessionId: string): Promise<void> {
  if (p.role === 'admin') return
  if (p.role !== 'device' || !p.deviceId) throw forbidden('only devices can write to a session')
  const [row] = await db().select({ id: sp.id }).from(sp)
    .where(and(eq(sp.sessionId, sessionId), eq(sp.deviceId, p.deviceId), isNull(sp.leftAt))).limit(1)
  if (!row) throw forbidden('device is not a participant of this session')
}

async function assertCanRead(p: Principal, row: SessionRow): Promise<void> {
  if (canReadSession(p, row, false)) return
  if (await isParticipantOf(p, row.id)) return
  throw forbidden('not a participant of this party')
}

/** Eight tries is astronomically more than enough for a 32^8 space; it guards against a bad RNG, not luck. */
async function allocateInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateInviteCode()
    const [clash] = await db().select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.inviteCode, code)).limit(1)
    if (!clash) return code
  }
  throw new AppError('internal', 'could not allocate a unique invite code')
}

async function displayNameFor(p: Principal, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  if (p.deviceId) {
    const [d] = await db().select({ name: schema.devices.name }).from(schema.devices).where(eq(schema.devices.id, p.deviceId)).limit(1)
    if (d?.name) return d.name
  }
  if (p.userId) {
    const [u] = await db().select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, p.userId)).limit(1)
    if (u?.name) return u.name
    if (u?.email) return u.email
  }
  return p.email ?? 'Guest'
}

const ablyClientId = (p: Principal): string =>
  p.deviceId ?? (p.userId ? `user-${p.userId}` : `${p.role}-${crypto.randomUUID().slice(0, 8)}`)

/** The Ably block returned with a join; `null` when this deployment has no Ably key. */
async function realtimeFor(p: Principal, sessionId: string, canPublish: boolean) {
  if (!isAblyConfigured()) return null
  try {
    const tokenRequest = await createTokenRequest({ clientId: ablyClientId(p), sessionId, publish: canPublish, admin: p.role === 'admin' })
    return { token_request: tokenRequest, channel: sessionChannel(sessionId), can_publish: canPublish || p.role === 'admin' }
  } catch (e) {
    console.error('ably token request failed', e)
    return null
  }
}

const sessionPayload = (row: SessionRow, rows: ParticipantRow[]) => ({
  session: row,
  participants: rows.map(publicParticipant),
  channel: sessionChannel(row.id),
  share_url: shareUrlFor(row),
})

/** Shared by `POST /v1/sessions/join` (by code) and the legacy `POST /v1/sessions/:id/join`. */
async function joinParty(p: Principal, row: SessionRow, opts: { kind?: ParticipantKind; displayName?: string }) {
  if (p.role === 'client' || p.role === 'worker') throw forbidden('this credential cannot join a party')
  const kind: ParticipantKind = opts.kind ?? (p.deviceId ? 'device' : 'viewer')
  if (kind === 'device' && !p.deviceId) throw badRequest('joining as a mapper requires a device token')
  const identity = identityOf(p)
  if (!p.deviceId && !p.userId) throw badRequest('joining requires a device token or a signed-in account')

  const rows = await participants(row.id)
  const decision = joinDecision({ status: row.status, maxParticipants: row.maxParticipants, participants: rows, identity })
  if (!decision.ok) {
    if (decision.reason === 'session_ended') throw sessionEnded(row.status)
    throw sessionFull(row.maxParticipants)
  }

  const existing = matchParticipant(rows, rowIdentityOf(p))
  const displayName = await displayNameFor(p, opts.displayName)
  let me: ParticipantRow | undefined
  if (existing) {
    // Rejoin: clear left_at, keep the colour and the original join order.
    const [updated] = await db().update(sp)
      .set({ leftAt: null, kind, displayName, userId: p.userId ?? existing.userId ?? null })
      .where(eq(sp.id, existing.id)).returning()
    me = updated
  } else {
    const [inserted] = await db().insert(sp).values({
      id: newId(),
      sessionId: row.id,
      deviceId: p.deviceId ?? null,
      userId: p.userId ?? null,
      kind,
      color: pickColor(rows.map((r) => r.color)),
      displayName,
      role: 'member',
    }).returning()
    me = inserted
  }
  if (!me) throw new AppError('internal', 'could not record the participant')

  const after = await participants(row.id)
  if (isAblyConfigured()) await publish(row.id, 'participant', { event: 'joined', participant: publicParticipant(me) }).catch(() => undefined)
  return {
    ...sessionPayload(row, after),
    me: publicParticipant(me),
    // Active participants publish regardless of kind: mappers send poses, viewers send presence.
    realtime: await realtimeFor(p, row.id, true),
  }
}

/** Bodies on the legacy join route are optional, so it is parsed by hand instead of with zValidator. */
async function optionalJoinBody(c: { req: { json: () => Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => ({}))
  const parsed = joinSessionById.safeParse(raw ?? {})
  if (!parsed.success) throw badRequest('invalid join body', parsed.error.issues)
  return parsed.data
}

sessions.post('/v1/sessions', requireAuth('device', 'user'), zValidator('json', createSession), async (c) => {
  const p = c.get('principal')
  const body = c.req.valid('json')
  if (body.base_map_id) {
    const [base] = await db().select().from(schema.maps).where(eq(schema.maps.id, body.base_map_id)).limit(1)
    if (!base) throw notFound('base map')
  }
  const id = newId()
  const [row] = await db().insert(schema.sessions).values({
    id,
    name: body.name,
    origin: body.origin,
    leaderDeviceId: p.deviceId ?? null,
    ownerUserId: p.userId ?? null,
    inviteCode: await allocateInviteCode(),
    maxParticipants: body.max_participants,
    baseMapId: body.base_map_id ?? null,
    status: 'active',
  }).returning()
  if (!row) throw new AppError('internal', 'could not create the session')
  // A device creator is also the leader participant; a browser owner joins like anyone else.
  if (p.deviceId) {
    await db().insert(sp).values({
      id: newId(), sessionId: id, deviceId: p.deviceId, userId: p.userId ?? null,
      kind: 'device', color: pickColor([]), displayName: await displayNameFor(p), role: 'leader',
    })
  }
  return c.json(sessionPayload(row, await participants(id)), 201)
})

sessions.get('/v1/sessions', requireAuth('device', 'client', 'user'), zValidator('query', listQuery), async (c) => {
  const p = c.get('principal')
  const q = c.req.valid('query')
  const conds: SQL[] = []
  if (q.status) conds.push(eq(schema.sessions.status, q.status))
  if (p.role === 'device' || p.role === 'user') {
    const mine = participantMatchesPrincipal(p)
    const visible = or(
      p.userId ? eq(schema.sessions.ownerUserId, p.userId) : undefined,
      p.deviceId ? eq(schema.sessions.leaderDeviceId, p.deviceId) : undefined,
      mine ? exists(db().select({ one: sql`1` }).from(sp).where(and(eq(sp.sessionId, schema.sessions.id), mine))) : undefined,
    )
    conds.push(visible ?? sql`false`)
  }
  const rows = await db().select().from(schema.sessions).where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.sessions.createdAt)).limit(q.limit)
  return c.json({ sessions: rows })
})

/** Party summary for the `/join/:code` landing page — any authenticated role may look a code up. */
sessions.get('/v1/sessions/by-code/:code', requireAuth('device', 'client', 'user'), async (c) => {
  const p = c.get('principal')
  const code = normalizeInviteCode(c.req.param('code'))
  if (!isInviteCode(code)) throw badRequest('invite code must be 8 base32 characters (A-Z, 2-7)')
  const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.inviteCode, code)).limit(1)
  if (!row) throw notFound('party')
  const rows = await participants(row.id)
  const decision = joinDecision({ status: row.status, maxParticipants: row.maxParticipants, participants: rows, identity: identityOf(p) })
  let ownerName: string | null = null
  if (row.ownerUserId) {
    const [owner] = await db().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, row.ownerUserId)).limit(1)
    ownerName = owner?.name ?? null
  }
  return c.json({
    session: {
      id: row.id,
      name: row.name,
      status: row.status,
      origin: row.origin,
      invite_code: row.inviteCode,
      share_url: shareUrlFor(row),
      participant_count: decision.activeCount,
      max_participants: row.maxParticipants,
      owner_name: ownerName,
    },
    can_join: decision.ok,
    reason: decision.reason ?? null,
  })
})

/** Join by invite code. Devices join as mappers, signed-in browsers as viewers. */
sessions.post('/v1/sessions/join', requireAuth('device', 'user'), zValidator('json', joinSession), async (c) => {
  const p = c.get('principal')
  const body = c.req.valid('json')
  const [row] = await db().select().from(schema.sessions).where(eq(schema.sessions.inviteCode, body.code)).limit(1)
  if (!row) throw notFound('party')
  return c.json(await joinParty(p, row, { kind: body.kind, displayName: body.display_name }))
})

sessions.get('/v1/sessions/:id', requireAuth('device', 'client', 'user'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  await assertCanRead(p, row)
  return c.json(sessionPayload(row, await participants(row.id)))
})

sessions.post('/v1/sessions/:id/join', requireAuth('device', 'user'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  const body = await optionalJoinBody(c)
  return c.json(await joinParty(p, row, { kind: body.kind, displayName: body.display_name }))
})

sessions.post('/v1/sessions/:id/leave', requireAuth('device', 'user'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  const mine = participantMatchesPrincipal(p)
  if (!mine) throw forbidden('this credential is not a participant')
  const left = await db().update(sp).set({ leftAt: new Date() })
    .where(and(eq(sp.sessionId, row.id), mine, isNull(sp.leftAt))).returning()
  if (isAblyConfigured()) {
    for (const r of left) await publish(row.id, 'participant', { event: 'left', participant: publicParticipant(r) }).catch(() => undefined)
  }
  return c.json({ left: true, participants: (await participants(row.id)).map(publicParticipant) })
})

/** The owner account, the leader device or an admin ends the party. */
sessions.post('/v1/sessions/:id/end', requireAuth('device', 'user'), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  if (!canEndSession(p, row)) throw forbidden('only the party owner or leader device can end it')
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
    trackingState: k.tracking_state, worldMappingStatus: k.world_mapping_status, aligned: k.aligned,
    depthRef: k.depth_ref ?? keyframeObjectPath(row.id, deviceId, k.seq, 'depth'),
    confidenceRef: k.confidence_ref ?? keyframeObjectPath(row.id, deviceId, k.seq, 'confidence'),
    jpegRef: k.jpeg_ref ?? null, meshRef: k.mesh_ref ?? null, pointsInline: k.points_inline ?? null, bytes: k.bytes,
  }))
  const inserted = await db().insert(schema.keyframes).values(values)
    .onConflictDoUpdate({ target: [schema.keyframes.sessionId, schema.keyframes.deviceId, schema.keyframes.seq], set: { t: sql`excluded.t`, pose: sql`excluded.pose`, aligned: sql`excluded.aligned`, pointsInline: sql`excluded.points_inline`, bytes: sql`excluded.bytes` } })
    .returning({ id: schema.keyframes.id, seq: schema.keyframes.seq })
  const bytes = values.reduce((s, v) => s + v.bytes, 0)
  await db().update(schema.sessions).set({ keyframeCount: sql`${schema.sessions.keyframeCount} + ${values.length}`, bytes: sql`${schema.sessions.bytes} + ${bytes}` }).where(eq(schema.sessions.id, row.id))
  if (isAblyConfigured()) {
    // Live viewers get pose + intrinsics + inline points; blobs stay in GCS and are referenced by path.
    const [mine] = await db().select({ userId: sp.userId, color: sp.color }).from(sp)
      .where(and(eq(sp.sessionId, row.id), eq(sp.deviceId, deviceId))).limit(1)
    await publish(row.id, 'keyframes', {
      device_id: deviceId,
      user_id: mine?.userId ?? p.userId ?? null,
      color: mine?.color ?? null,
      keyframes: items.map((k) => ({ seq: k.seq, t: k.t, pose: k.pose, intrinsics: k.intrinsics, tracking_state: k.tracking_state, aligned: k.aligned, depth_ref: keyframeObjectPath(row.id, deviceId, k.seq, 'depth'), points_inline: k.points_inline ?? null })),
    }).catch((e) => console.error('ably publish failed', e))
  }
  return c.json({ registered: inserted }, 201)
})

/** Catch-up for viewers: keyframes after `since_id`, optionally with signed download URLs. */
sessions.get('/v1/sessions/:id/keyframes', requireAuth('device', 'client', 'user'), zValidator('query', keyframeQuery), async (c) => {
  const p = c.get('principal')
  const row = await loadSession(c.req.param('id'))
  await assertCanRead(p, row)
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
