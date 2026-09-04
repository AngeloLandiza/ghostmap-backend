import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, exists, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth, type Principal } from '../lib/auth.js'
import { canWriteMap, isReadEverything } from '../lib/access.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { MAP_FILES, deletePrefix, mapFileContentType, mapObjectPath, signDownload, signUpload, statObject, type MapFile } from '../lib/gcs.js'
import { newId } from '../lib/ids.js'
import { createMap, finalizeMap, listQuery, patchMap, uploadUrls } from '../schemas.js'

export const maps = new Hono()

const LARGE: ReadonlySet<MapFile> = new Set(['cloud.ply', 'keyframes.bin'])

async function loadMap(id: string) {
  const [row] = await db().select().from(schema.maps).where(eq(schema.maps.id, id)).limit(1)
  if (!row || row.status === 'deleted') throw notFound('map')
  return row
}

function assertOwner(p: Principal, row: { deviceId: string | null; ownerUserId: string | null; sessionId: string | null }) {
  if (!canWriteMap(p, row)) throw forbidden('map belongs to another account')
}

const sp = schema.sessionParticipants

/** SQL for "a participant row in this session belongs to the caller". */
function participantMatchesPrincipal(p: Principal): SQL | undefined {
  const parts: SQL[] = []
  if (p.deviceId) parts.push(eq(sp.deviceId, p.deviceId))
  if (p.userId) parts.push(eq(sp.userId, p.userId))
  return parts.length ? or(...parts) : undefined
}

/**
 * Visibility (PLAN §1): own maps, maps from a session the caller takes (or took) part in, plus
 * pre-accounts rows that belong to nobody. Admin and the legacy read-only `client` key see everything.
 */
function visibleMaps(p: Principal): SQL | undefined {
  if (isReadEverything(p)) return undefined
  const mine = participantMatchesPrincipal(p)
  return or(
    p.userId ? eq(schema.maps.ownerUserId, p.userId) : undefined,
    p.deviceId ? eq(schema.maps.deviceId, p.deviceId) : undefined,
    and(isNull(schema.maps.ownerUserId), isNull(schema.maps.deviceId)),
    mine ? exists(db().select({ one: sql`1` }).from(sp).where(and(eq(sp.sessionId, schema.maps.sessionId), mine))) : undefined,
  ) ?? sql`false`
}

async function assertCanRead(p: Principal, row: { deviceId: string | null; ownerUserId: string | null; sessionId: string | null }) {
  if (isReadEverything(p)) return
  if (canWriteMap(p, row)) return
  const mine = participantMatchesPrincipal(p)
  if (row.sessionId && mine) {
    const [seen] = await db().select({ id: sp.id }).from(sp).where(and(eq(sp.sessionId, row.sessionId), mine)).limit(1)
    if (seen) return
  }
  throw forbidden('map belongs to another account')
}

async function uploadSet(mapId: string, files: MapFile[]) {
  return Promise.all(files.map((f) => signUpload(mapObjectPath(mapId, f), mapFileContentType[f], { resumable: LARGE.has(f), ttlSeconds: 60 * 60 })))
}

/** List maps (newest first, cursor = created_at of the last row). */
maps.get('/v1/maps', requireAuth('device', 'client', 'user'), zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query')
  const conds = [ne(schema.maps.status, 'deleted')]
  const visible = visibleMaps(c.get('principal'))
  if (visible) conds.push(visible)
  if (q.status) conds.push(eq(schema.maps.status, q.status))
  if (q.session_id) conds.push(eq(schema.maps.sessionId, q.session_id))
  if (q.cursor) conds.push(lt(schema.maps.createdAt, new Date(q.cursor)))
  const rows = await db().select().from(schema.maps).where(and(...conds)).orderBy(desc(schema.maps.createdAt)).limit(q.limit)
  const next = rows.length === q.limit ? rows[rows.length - 1]?.createdAt.toISOString() : undefined
  return c.json({ maps: rows, next_cursor: next })
})

/** Create a map record and mint upload URLs for its files (upload directly to GCS, then finalize). */
maps.post('/v1/maps', requireAuth('device', 'user'), zValidator('json', createMap), async (c) => {
  const p = c.get('principal')
  const body = c.req.valid('json')
  const id = newId()
  let version = 1
  if (body.parent_map_id) {
    const parent = await loadMap(body.parent_map_id)
    version = parent.version + 1
  }
  const [row] = await db().insert(schema.maps).values({
    id, name: body.name, version, parentMapId: body.parent_map_id ?? null, sessionId: body.session_id ?? null,
    deviceId: p.deviceId ?? null, ownerUserId: p.userId ?? null, frame: body.frame, origin: body.origin, status: 'uploading', files: [],
  }).returning()
  const uploads = await uploadSet(id, body.files)
  return c.json({ map: row, uploads }, 201)
})

maps.post('/v1/maps/:id/upload-urls', requireAuth('device', 'user'), zValidator('json', uploadUrls), async (c) => {
  const row = await loadMap(c.req.param('id'))
  assertOwner(c.get('principal'), row)
  return c.json({ uploads: await uploadSet(row.id, c.req.valid('json').files) })
})

/** Verify the uploaded objects, read the manifest, mark the map saved. */
maps.post('/v1/maps/:id/finalize', requireAuth('device', 'user'), zValidator('json', finalizeMap), async (c) => {
  const row = await loadMap(c.req.param('id'))
  assertOwner(c.get('principal'), row)
  const present: string[] = []
  let sizeBytes = 0
  for (const f of MAP_FILES) {
    const info = await statObject(mapObjectPath(row.id, f))
    if (info) { present.push(f); sizeBytes += info.size }
  }
  if (!present.includes('cloud.ply')) throw badRequest('cloud.ply has not been uploaded', { present })
  let manifest = c.req.valid('json').manifest ?? null
  if (!manifest && present.includes('manifest.json')) {
    const [buf] = await (await import('../lib/gcs.js')).gcsBucket().file(mapObjectPath(row.id, 'manifest.json')).download()
    try { manifest = JSON.parse(buf.toString('utf8')) } catch { throw badRequest('manifest.json is not valid JSON') }
  }
  const m = (manifest ?? {}) as Record<string, unknown>
  const [updated] = await db().update(schema.maps).set({
    status: 'saved', manifest, files: present, sizeBytes,
    pointCount: Number(m.point_count ?? row.pointCount), keyframeCount: Number(m.keyframe_count ?? row.keyframeCount),
    bbox: (m.bbox as Record<string, unknown> | undefined) ?? row.bbox, durationS: Number(m.duration_s ?? row.durationS),
    name: typeof m.name === 'string' && m.name ? m.name : row.name, finalizedAt: new Date(),
  }).where(eq(schema.maps.id, row.id)).returning()
  return c.json({ map: updated })
})

/** Map record plus short-lived download URLs for every stored file. */
maps.get('/v1/maps/:id', requireAuth('device', 'client', 'user'), async (c) => {
  const row = await loadMap(c.req.param('id'))
  await assertCanRead(c.get('principal'), row)
  const downloads: Record<string, { url: string; expires_at: string }> = {}
  for (const f of row.files) {
    if ((MAP_FILES as readonly string[]).includes(f)) downloads[f] = await signDownload(mapObjectPath(row.id, f as MapFile))
  }
  return c.json({ map: row, downloads })
})

maps.get('/v1/maps/:id/files/:name', requireAuth('device', 'client', 'user'), async (c) => {
  const row = await loadMap(c.req.param('id'))
  await assertCanRead(c.get('principal'), row)
  const name = c.req.param('name') as MapFile
  if (!(MAP_FILES as readonly string[]).includes(name) || !row.files.includes(name)) throw notFound('file')
  const { url } = await signDownload(mapObjectPath(row.id, name), 5 * 60)
  return c.redirect(url, 302)
})

maps.patch('/v1/maps/:id', requireAuth('device', 'user'), zValidator('json', patchMap), async (c) => {
  const row = await loadMap(c.req.param('id'))
  assertOwner(c.get('principal'), row)
  const [updated] = await db().update(schema.maps).set({ name: c.req.valid('json').name }).where(eq(schema.maps.id, row.id)).returning()
  return c.json({ map: updated })
})

maps.delete('/v1/maps/:id', requireAuth('device', 'user'), async (c) => {
  const row = await loadMap(c.req.param('id'))
  assertOwner(c.get('principal'), row)
  const removed = await deletePrefix(`maps/${row.id}/`)
  await db().update(schema.maps).set({ status: 'deleted', files: [] }).where(eq(schema.maps.id, row.id))
  return c.json({ deleted: true, objects_removed: removed })
})
