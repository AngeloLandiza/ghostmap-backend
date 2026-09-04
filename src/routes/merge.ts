import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth } from '../lib/auth.js'
import { canEndSession } from '../lib/access.js'
import { isAblyConfigured, publish } from '../lib/ably.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { runMergeJob } from '../lib/gcp.js'
import { newId } from '../lib/ids.js'
import { env } from '../env.js'
import { completeMergeJob, listQuery } from '../schemas.js'

export const merge = new Hono()

async function loadJob(id: string) {
  const [row] = await db().select().from(schema.mergeJobs).where(eq(schema.mergeJobs.id, id)).limit(1)
  if (!row) throw notFound('merge job')
  return row
}

/**
 * Queue a merge of everything captured in a session (plus its base map). If CLOUD_RUN_MERGE_JOB is set the
 * Cloud Run job is started immediately; otherwise a worker polls GET /v1/merge-jobs/next.
 */
merge.post('/v1/sessions/:id/merge', requireAuth('device', 'user'), async (c) => {
  const p = c.get('principal')
  const [session] = await db().select().from(schema.sessions).where(eq(schema.sessions.id, c.req.param('id'))).limit(1)
  if (!session) throw notFound('session')
  if (!canEndSession(p, session)) throw forbidden('only the party owner or leader device can request a merge')
  if (session.status === 'active') throw badRequest('end the session before merging')
  const inputs = await db().select({ id: schema.maps.id }).from(schema.maps).where(and(eq(schema.maps.sessionId, session.id), eq(schema.maps.status, 'saved')))
  const inputMapIds = inputs.map((m) => m.id)
  if (session.baseMapId) inputMapIds.unshift(session.baseMapId)
  const id = newId()
  const [job] = await db().insert(schema.mergeJobs).values({ id, sessionId: session.id, status: 'queued', requestedBy: p.deviceId ?? null, inputMapIds }).returning()
  await db().update(schema.sessions).set({ status: 'merging' }).where(eq(schema.sessions.id, session.id))
  let execution: string | undefined
  if (env().CLOUD_RUN_MERGE_JOB) {
    try {
      execution = await runMergeJob(id)
      await db().update(schema.mergeJobs).set({ cloudRunExecution: execution }).where(eq(schema.mergeJobs.id, id))
    } catch (e) {
      console.error('cloud run trigger failed', e)
    }
  }
  return c.json({ job: { ...job, cloudRunExecution: execution ?? null } }, 202)
})

merge.get('/v1/merge-jobs', requireAuth('device', 'client', 'user', 'worker'), zValidator('query', listQuery), async (c) => {
  const q = c.req.valid('query')
  const conds = []
  if (q.status) conds.push(eq(schema.mergeJobs.status, q.status))
  if (q.session_id) conds.push(eq(schema.mergeJobs.sessionId, q.session_id))
  const rows = await db().select().from(schema.mergeJobs).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.mergeJobs.createdAt)).limit(q.limit)
  return c.json({ jobs: rows })
})

/** Worker pull model: claim the oldest queued job. */
merge.post('/v1/merge-jobs/next', requireAuth('worker'), async (c) => {
  const [job] = await db().select().from(schema.mergeJobs).where(and(eq(schema.mergeJobs.status, 'queued'), isNull(schema.mergeJobs.startedAt))).orderBy(asc(schema.mergeJobs.createdAt)).limit(1)
  if (!job) return c.json({ job: null })
  const [claimed] = await db().update(schema.mergeJobs).set({ status: 'running', startedAt: new Date(), worker: c.req.header('x-worker-id') ?? 'worker' })
    .where(and(eq(schema.mergeJobs.id, job.id), eq(schema.mergeJobs.status, 'queued'))).returning()
  return c.json({ job: claimed ?? null })
})

merge.get('/v1/merge-jobs/:id', requireAuth('device', 'client', 'user', 'worker'), async (c) => {
  return c.json({ job: await loadJob(c.req.param('id')) })
})

merge.post('/v1/merge-jobs/:id/claim', requireAuth('worker'), async (c) => {
  const job = await loadJob(c.req.param('id'))
  if (job.status !== 'queued') throw badRequest(`job is ${job.status}`)
  const [claimed] = await db().update(schema.mergeJobs).set({ status: 'running', startedAt: new Date(), worker: c.req.header('x-worker-id') ?? 'worker' }).where(eq(schema.mergeJobs.id, job.id)).returning()
  return c.json({ job: claimed })
})

/** Worker reports the result: a new map version (output_map_id, created via POST /v1/maps by an admin/worker token) or an error. */
merge.post('/v1/merge-jobs/:id/complete', requireAuth('worker'), zValidator('json', completeMergeJob), async (c) => {
  const job = await loadJob(c.req.param('id'))
  const body = c.req.valid('json')
  const ok = Boolean(body.output_map_id) && !body.error
  const [updated] = await db().update(schema.mergeJobs).set({ status: ok ? 'succeeded' : 'failed', outputMapId: body.output_map_id ?? null, error: body.error ?? null, finishedAt: new Date() }).where(eq(schema.mergeJobs.id, job.id)).returning()
  await db().update(schema.sessions).set({ status: ok ? 'merged' : 'failed', mergedMapId: body.output_map_id ?? null }).where(eq(schema.sessions.id, job.sessionId))
  if (isAblyConfigured()) await publish(job.sessionId, 'merge', { event: ok ? 'succeeded' : 'failed', job_id: job.id, map_id: body.output_map_id ?? null, error: body.error ?? null }).catch(() => undefined)
  return c.json({ job: updated })
})
