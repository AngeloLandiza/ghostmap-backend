import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { desc, gte, sql } from 'drizzle-orm'
import { db, schema } from '../db/client.js'
import { requireAuth } from '../lib/auth.js'
import { cached } from '../lib/cache.js'
import { ablyHealth, isAblyConfigured } from '../lib/ably.js'
import { env } from '../env.js'
import { bucketStats, isGcsConfigured } from '../lib/gcs.js'
import { gcpHealth, listSkuPrices, queryCosts } from '../lib/gcp.js'
import { isNewRelicConfigured, newRelicHealth, sendEvents, sendMetrics, type NRMetric } from '../lib/newrelic.js'
import { daysQuery, pricingQuery, windowQuery } from '../schemas.js'

/** Drizzle's Neon HTTP driver returns `{ rows }` from raw `execute()`; normalize to an array of rows. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const r = (result as { rows?: unknown }).rows
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}
import { runMigrations } from '../db/migrate.js'

export const admin = new Hono()
admin.use('/admin/*', requireAuth('admin'))

/** Creates/updates the database schema from the bundled SQL (idempotent). Run once after connecting the database. */
admin.post('/admin/db/migrate', async (c) => c.json(await runMigrations()))

admin.get('/admin/overview', async (c) => {
  const [counts] = rowsOf(await db().execute(sql`
    SELECT (SELECT count(*) FROM devices) AS devices,
           (SELECT count(*) FROM maps WHERE status <> 'deleted') AS maps,
           (SELECT coalesce(sum(size_bytes),0) FROM maps WHERE status = 'saved') AS map_bytes,
           (SELECT count(*) FROM sessions WHERE status = 'active') AS active_sessions,
           (SELECT count(*) FROM sessions) AS sessions,
           (SELECT count(*) FROM keyframes) AS keyframes,
           (SELECT count(*) FROM merge_jobs WHERE status IN ('queued','running')) AS pending_merges`))
  return c.json({ overview: counts, region: env().VERCEL_REGION ?? 'local', version: env().APP_VERSION })
})

/** Networking stats from api_usage: volume, latency percentiles, bytes, by route, region and country. */
export async function networkStats(hours: number) {
  const since = new Date(Date.now() - hours * 3600 * 1000)
  const totals = rowsOf(await db().execute(sql`
    SELECT count(*)::int AS requests,
           count(*) FILTER (WHERE status >= 500)::int AS server_errors,
           count(*) FILTER (WHERE status >= 400 AND status < 500)::int AS client_errors,
           coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms),0) AS p50_ms,
           coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms),0) AS p95_ms,
           coalesce(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms),0) AS p99_ms,
           coalesce(avg(duration_ms),0) AS avg_ms,
           coalesce(sum(bytes_in),0)::bigint AS bytes_in,
           coalesce(sum(bytes_out),0)::bigint AS bytes_out
    FROM api_usage WHERE ts >= ${since}`))
  const byRoute = rowsOf(await db().execute(sql`
    SELECT method, route, count(*)::int AS requests,
           coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms),0) AS p95_ms,
           coalesce(avg(duration_ms),0) AS avg_ms,
           count(*) FILTER (WHERE status >= 500)::int AS errors,
           coalesce(sum(bytes_in),0)::bigint AS bytes_in, coalesce(sum(bytes_out),0)::bigint AS bytes_out
    FROM api_usage WHERE ts >= ${since} GROUP BY method, route ORDER BY requests DESC LIMIT 50`))
  const byRegion = rowsOf(await db().execute(sql`
    SELECT coalesce(region,'unknown') AS region, count(*)::int AS requests, coalesce(avg(duration_ms),0) AS avg_ms
    FROM api_usage WHERE ts >= ${since} GROUP BY 1 ORDER BY 2 DESC`))
  const byCountry = rowsOf(await db().execute(sql`
    SELECT coalesce(country,'unknown') AS country, count(*)::int AS requests
    FROM api_usage WHERE ts >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`))
  const perHour = rowsOf(await db().execute(sql`
    SELECT date_trunc('hour', ts) AS hour, count(*)::int AS requests, coalesce(sum(bytes_in+bytes_out),0)::bigint AS bytes
    FROM api_usage WHERE ts >= ${since} GROUP BY 1 ORDER BY 1`))
  return { window_hours: hours, since: since.toISOString(), totals: totals[0] ?? {}, by_route: byRoute, by_region: byRegion, by_country: byCountry, per_hour: perHour }
}

admin.get('/admin/network', zValidator('query', windowQuery), async (c) => c.json(await networkStats(c.req.valid('query').hours)))

admin.get('/admin/storage', async (c) => {
  if (!isGcsConfigured()) return c.json({ configured: false })
  const r = await cached('gcs_bucket_stats', 600, bucketStats)
  return c.json({ configured: true, bucket: env().GCS_BUCKET, ...r.value, cached: r.cached, updated_at: r.updated_at })
})

admin.get('/admin/costs', zValidator('query', daysQuery), async (c) => {
  const { days } = c.req.valid('query')
  const r = await cached(`gcp_costs_${days}`, 3600, () => queryCosts(days))
  return c.json({ days, ...r.value, cached: r.cached, updated_at: r.updated_at })
})

admin.get('/admin/pricing', zValidator('query', pricingQuery), async (c) => {
  const { service, region } = c.req.valid('query')
  const r = await cached(`gcp_pricing_${service}_${region ?? 'all'}`, 86400, () => listSkuPrices(service, region))
  return c.json({ service, region: region ?? null, skus: r.value, cached: r.cached, updated_at: r.updated_at })
})

admin.get('/admin/sessions', async (c) => {
  const rows = await db().select().from(schema.sessions).orderBy(desc(schema.sessions.createdAt)).limit(200)
  return c.json({ sessions: rows })
})

admin.get('/admin/usage/recent', async (c) => {
  const rows = await db().select().from(schema.apiUsage).where(gte(schema.apiUsage.ts, new Date(Date.now() - 3600 * 1000))).orderBy(desc(schema.apiUsage.ts)).limit(200)
  return c.json({ usage: rows })
})

admin.get('/admin/health', async (c) => {
  const dbOk = await db().execute(sql`select 1`).then(() => ({ ok: true })).catch((e) => ({ ok: false, detail: String(e) }))
  const gcs = isGcsConfigured() ? await gcpHealth() : { ok: false, detail: 'not configured' }
  const ably = isAblyConfigured() ? await ablyHealth() : { ok: false, detail: 'not configured' }
  const nr = isNewRelicConfigured() ? await newRelicHealth() : { ok: false, detail: 'not configured' }
  return c.json({ ok: dbOk.ok, checks: { database: dbOk, gcp: gcs, ably, newrelic: nr }, region: env().VERCEL_REGION ?? 'local' })
})

/**
 * Push network, storage, cost and inventory metrics to New Relic. Called once a day by Vercel Cron
 * (Authorization: Bearer CRON_SECRET) or manually with the admin key.
 */
async function pushToNewRelic() {
  if (!isNewRelicConfigured()) return { sent: false, reason: 'NEW_RELIC_LICENSE_KEY not set' }
  const metrics: NRMetric[] = []
  const net = await networkStats(1)
  const t = net.totals as Record<string, number | string>
  const num = (v: unknown) => Number(v ?? 0)
  metrics.push(
    { name: 'ghostmap.api.requests', type: 'gauge', value: num(t.requests), attributes: { window: '1h' } },
    { name: 'ghostmap.api.errors.server', type: 'gauge', value: num(t.server_errors), attributes: { window: '1h' } },
    { name: 'ghostmap.api.errors.client', type: 'gauge', value: num(t.client_errors), attributes: { window: '1h' } },
    { name: 'ghostmap.api.latency.p50_ms', type: 'gauge', value: num(t.p50_ms) },
    { name: 'ghostmap.api.latency.p95_ms', type: 'gauge', value: num(t.p95_ms) },
    { name: 'ghostmap.api.latency.p99_ms', type: 'gauge', value: num(t.p99_ms) },
    { name: 'ghostmap.api.bytes.in', type: 'gauge', value: num(t.bytes_in), attributes: { window: '1h' } },
    { name: 'ghostmap.api.bytes.out', type: 'gauge', value: num(t.bytes_out), attributes: { window: '1h' } },
  )
  for (const r of net.by_route) {
    metrics.push({ name: 'ghostmap.api.route.requests', type: 'gauge', value: num(r.requests), attributes: { method: String(r.method), route: String(r.route), window: '1h' } })
    metrics.push({ name: 'ghostmap.api.route.p95_ms', type: 'gauge', value: num(r.p95_ms), attributes: { method: String(r.method), route: String(r.route) } })
  }
  for (const r of net.by_region) metrics.push({ name: 'ghostmap.api.region.requests', type: 'gauge', value: num(r.requests), attributes: { region: String(r.region), window: '1h' } })
  for (const r of net.by_country) metrics.push({ name: 'ghostmap.api.country.requests', type: 'gauge', value: num(r.requests), attributes: { country: String(r.country), window: '1h' } })

  const [inv] = rowsOf(await db().execute(sql`
    SELECT (SELECT count(*) FROM devices)::int AS devices, (SELECT count(*) FROM maps WHERE status='saved')::int AS maps,
           (SELECT coalesce(sum(size_bytes),0) FROM maps WHERE status='saved')::bigint AS map_bytes,
           (SELECT count(*) FROM sessions WHERE status='active')::int AS active_sessions,
           (SELECT count(*) FROM keyframes)::int AS keyframes,
           (SELECT count(*) FROM merge_jobs WHERE status IN ('queued','running'))::int AS pending_merges`))
  for (const [k, v] of Object.entries(inv ?? {})) metrics.push({ name: `ghostmap.inventory.${k}`, type: 'gauge', value: num(v) })

  let storage: Awaited<ReturnType<typeof bucketStats>> | undefined
  if (isGcsConfigured()) {
    storage = (await cached('gcs_bucket_stats', 600, bucketStats)).value
    metrics.push({ name: 'ghostmap.gcs.bytes', type: 'gauge', value: storage.total_bytes }, { name: 'ghostmap.gcs.objects', type: 'gauge', value: storage.total_objects })
    for (const [prefix, s] of Object.entries(storage.prefixes)) metrics.push({ name: 'ghostmap.gcs.prefix.bytes', type: 'gauge', value: s.bytes, attributes: { prefix } })
    // Public list price for standard regional storage ≈ $0.020–0.026 / GB-month; a monthly estimate from bytes.
    metrics.push({ name: 'ghostmap.gcs.estimated_monthly_usd', type: 'gauge', value: (storage.total_bytes / 1e9) * 0.023 })
  }

  let costs: Awaited<ReturnType<typeof queryCosts>> | undefined
  if (env().BILLING_EXPORT_TABLE) {
    try {
      costs = (await cached('gcp_costs_30', 3600, () => queryCosts(30))).value
      metrics.push({ name: 'ghostmap.gcp.cost.30d_usd', type: 'gauge', value: costs.total_usd })
      for (const [service, usd] of Object.entries(costs.by_service)) metrics.push({ name: 'ghostmap.gcp.cost.service_30d_usd', type: 'gauge', value: usd, attributes: { gcp_service: service } })
      const today = costs.rows.filter((r) => r.day === costs?.rows[0]?.day).reduce((s, r) => s + r.cost_usd + r.credits_usd, 0)
      metrics.push({ name: 'ghostmap.gcp.cost.latest_day_usd', type: 'gauge', value: today })
    } catch (e) {
      console.error('cost query failed', e)
    }
  }

  const metricResult = await sendMetrics(metrics)
  const eventResult = await sendEvents([{ eventType: 'GhostmapSnapshot', requests_1h: num(t.requests), p95_ms: num(t.p95_ms), gcs_bytes: storage?.total_bytes ?? 0, cost_30d_usd: costs?.total_usd ?? 0, region: env().VERCEL_REGION ?? 'local' }])
  return { sent: metricResult.ok, metrics: metrics.length, metric_api: metricResult, event_api: eventResult }
}

admin.get('/admin/newrelic/push', async (c) => c.json(await pushToNewRelic()))
admin.post('/admin/newrelic/push', async (c) => c.json(await pushToNewRelic()))
