/**
 * PLAN §3 — measured usage for a window, turned into the monthly quantities `engine.ts` prices.
 *
 * Sources: `api_usage` (one row per request), `usage_events` (the counters in `lib/usageEvents.ts`),
 * the cached GCS bucket statistics, `pg_database_size` and the inventory counts. Anything that cannot be
 * observed from the server — a device publishing pose straight to Ably, bytes Google Cloud actually
 * shipped — is estimated, and every estimate says so in the item's `basis`.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { cached } from '../cache.js'
import { bucketStats, isGcsConfigured } from '../gcs.js'
import { USAGE_EVENT_KINDS, type UsageEventKind } from '../usageEvents.js'
import { MONTH_DAYS } from './pricing.js'
import type { QuantityInput } from './engine.js'

/** Stated assumptions for numbers the server cannot measure directly. */
export const USAGE_CONSTANTS = {
  /** Share of a request's wall time that is Active CPU rather than waiting on Neon/GCS/Ably. */
  ACTIVE_CPU_FRACTION: 0.35,
  /** `vercel.json` gives the function 1024 MB. */
  FUNCTION_MEMORY_GB: 1,
  /** Neon suspends an idle compute after five minutes. */
  NEON_AUTOSUSPEND_SECONDS: 300,
  NEON_MIN_CU: 0.25,
  /** Bytes one New Relic metric costs in ingest when the push did not report its own size. */
  NR_BYTES_PER_METRIC: 250,
  /** Cloud Run merge job shape when the job did not report its own duration. */
  MERGE_SECONDS_FALLBACK: 120,
  MERGE_VCPU: 1,
  MERGE_GIB: 2,
  BQ_STORAGE_GIB: 1,
  NR_FULL_PLATFORM_USERS: 1,
} as const

const K = USAGE_CONSTANTS
const TIB = 1024 ** 4

/** Drizzle's Neon HTTP driver returns `{ rows }` from raw `execute()`; normalize to an array. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  const r = (result as { rows?: unknown }).rows
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : []
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export interface UsageEventTotals { count: number; bytes: number }

export interface MeasuredUsage {
  window_days: number
  since: string
  api: { requests: number; bytes_in: number; bytes_out: number; duration_ms: number; google_sign_ins: number }
  events: Record<UsageEventKind, UsageEventTotals>
  storage: { total_bytes: number; total_objects: number; avg_object_bytes: number; configured: boolean; cached: boolean; updated_at: string | null }
  database: { size_bytes: number }
  inventory: { keyframes: number; keyframe_bytes: number; maps: number; map_bytes: number; sessions: number; active_sessions: number; active_participants: number; participant_joins: number; participant_leaves: number }
  merges: { finished: number; seconds: number }
}

export interface UsageResult {
  measured: MeasuredUsage
  quantities: QuantityInput[]
  /** Things this window cannot see; surfaced so the dashboard can caveat the numbers. */
  caveats: string[]
}

const emptyEvents = (): Record<UsageEventKind, UsageEventTotals> =>
  Object.fromEntries(USAGE_EVENT_KINDS.map((k) => [k, { count: 0, bytes: 0 }])) as Record<UsageEventKind, UsageEventTotals>

/** Everything the database knows about the last `days` days. */
export async function measureUsage(days: number): Promise<MeasuredUsage> {
  const since = new Date(Date.now() - days * 86400 * 1000)

  const [api] = rowsOf(await db().execute(sql`
    SELECT count(*)::bigint AS requests,
           coalesce(sum(bytes_in),0)::bigint AS bytes_in,
           coalesce(sum(bytes_out),0)::bigint AS bytes_out,
           coalesce(sum(duration_ms),0)::bigint AS duration_ms,
           count(*) FILTER (WHERE route = '/v1/auth/google')::bigint AS google_sign_ins
    FROM api_usage WHERE ts >= ${since}`))

  const events = emptyEvents()
  for (const row of rowsOf(await db().execute(sql`
    SELECT kind, coalesce(sum(count),0)::bigint AS count, coalesce(sum(bytes),0)::bigint AS bytes
    FROM usage_events WHERE ts >= ${since} GROUP BY kind`))) {
    const kind = String(row.kind) as UsageEventKind
    if ((USAGE_EVENT_KINDS as readonly string[]).includes(kind)) events[kind] = { count: num(row.count), bytes: num(row.bytes) }
  }

  const [inv] = rowsOf(await db().execute(sql`
    SELECT (SELECT count(*) FROM keyframes)::bigint AS keyframes,
           (SELECT coalesce(sum(bytes),0) FROM keyframes)::bigint AS keyframe_bytes,
           (SELECT count(*) FROM maps WHERE status = 'saved')::bigint AS maps,
           (SELECT coalesce(sum(size_bytes),0) FROM maps WHERE status = 'saved')::bigint AS map_bytes,
           (SELECT count(*) FROM sessions)::bigint AS sessions,
           (SELECT count(*) FROM sessions WHERE status = 'active')::bigint AS active_sessions,
           (SELECT count(*) FROM session_participants WHERE left_at IS NULL)::bigint AS active_participants,
           (SELECT count(*) FROM session_participants WHERE joined_at >= ${since})::bigint AS participant_joins,
           (SELECT count(*) FROM session_participants WHERE left_at >= ${since})::bigint AS participant_leaves,
           (SELECT pg_database_size(current_database()))::bigint AS db_bytes`))

  const [merge] = rowsOf(await db().execute(sql`
    SELECT count(*)::bigint AS finished,
           coalesce(sum(EXTRACT(EPOCH FROM (finished_at - started_at))), 0) AS seconds
    FROM merge_jobs WHERE finished_at >= ${since} AND started_at IS NOT NULL`))

  let storage: MeasuredUsage['storage'] = {
    total_bytes: 0, total_objects: 0, avg_object_bytes: 0, configured: false, cached: false, updated_at: null,
  }
  if (isGcsConfigured()) {
    try {
      const r = await cached('gcs_bucket_stats', 600, bucketStats)
      const objects = r.value.total_objects
      storage = {
        total_bytes: r.value.total_bytes,
        total_objects: objects,
        avg_object_bytes: objects > 0 ? r.value.total_bytes / objects : 0,
        configured: true,
        cached: r.cached,
        updated_at: r.updated_at,
      }
    } catch (e) {
      console.error('bucket stats unavailable for the cost report', e)
    }
  }

  const finished = num(merge?.finished)
  const seconds = num(merge?.seconds)
  return {
    window_days: days,
    since: since.toISOString(),
    api: {
      requests: num(api?.requests),
      bytes_in: num(api?.bytes_in),
      bytes_out: num(api?.bytes_out),
      duration_ms: num(api?.duration_ms),
      google_sign_ins: num(api?.google_sign_ins),
    },
    events,
    storage,
    database: { size_bytes: num(inv?.db_bytes) },
    inventory: {
      keyframes: num(inv?.keyframes),
      keyframe_bytes: num(inv?.keyframe_bytes),
      maps: num(inv?.maps),
      map_bytes: num(inv?.map_bytes),
      sessions: num(inv?.sessions),
      active_sessions: num(inv?.active_sessions),
      active_participants: num(inv?.active_participants),
      participant_joins: num(inv?.participant_joins),
      participant_leaves: num(inv?.participant_leaves),
    },
    merges: { finished, seconds: seconds > 0 ? seconds : finished * K.MERGE_SECONDS_FALLBACK },
  }
}

/**
 * Measured window → monthly quantities. Flow metrics are scaled by `30 / window_days`; level metrics
 * (bytes stored, database size, peak connections) are passed through as measured.
 */
export function quantitiesFrom(m: MeasuredUsage): QuantityInput[] {
  const days = m.window_days > 0 ? m.window_days : 1
  const perMonth = (windowTotal: number): number => windowTotal * (MONTH_DAYS / days)
  const perDay = (windowTotal: number): number => windowTotal / days

  const e = m.events
  const flow = (provider: QuantityInput['provider'], metric: string, windowTotal: number, basis: string): QuantityInput => ({
    provider, metric, quantity: perMonth(windowTotal), measured: windowTotal, daily_rate: perDay(windowTotal), basis,
  })
  const level = (provider: QuantityInput['provider'], metric: string, value: number, basis: string): QuantityInput => ({
    provider, metric, quantity: value, measured: value, daily_rate: 0, basis,
  })

  // ---- Google Cloud Storage ----------------------------------------------------------------------
  // A signed URL is minted once per object the client then writes or reads, so mints stand in for the
  // Class A / Class B operations Google actually bills; listings are Class A too.
  const classA = e.signed_upload.count + e.gcs_list.count
  const classB = e.signed_download.count
  const egressBytes = e.signed_download.bytes > 0
    ? e.signed_download.bytes
    : e.signed_download.count * m.storage.avg_object_bytes

  // ---- Vercel -------------------------------------------------------------------------------------
  const durationHours = m.api.duration_ms / 3_600_000

  // ---- Neon ---------------------------------------------------------------------------------------
  const windowSeconds = days * 86400
  const awakeSeconds = Math.min(windowSeconds, m.api.requests * K.NEON_AUTOSUSPEND_SECONDS)
  const cuHours = (awakeSeconds / 3600) * K.NEON_MIN_CU

  // ---- Ably (PLAN §3: keyframe publishes × (active participants + 1) + presence events) ------------
  const fanout = m.inventory.active_participants + 1
  const presenceEvents = (m.inventory.participant_joins + m.inventory.participant_leaves) * fanout
  const ablyMessages = e.ably_publish.count * fanout + presenceEvents

  // ---- New Relic ----------------------------------------------------------------------------------
  const nrBytes = e.nr_push.bytes > 0 ? e.nr_push.bytes : e.nr_push.count * K.NR_BYTES_PER_METRIC

  return [
    level('gcs', 'storage_gb_month', m.storage.total_bytes / 1e9, 'gcs:bucket_stats'),
    flow('gcs', 'class_a_ops', classA, 'usage_events:signed_upload+gcs_list'),
    flow('gcs', 'class_b_ops', classB, 'usage_events:signed_download'),
    flow('gcs', 'egress_gb', egressBytes / 1e9, 'usage_events:signed_download × average object size'),

    level('neon', 'storage_gb', m.database.size_bytes / 1e9, 'pg_database_size'),
    flow('neon', 'compute_cu_hours', cuHours, `api_usage requests × ${K.NEON_AUTOSUSPEND_SECONDS}s autosuspend × ${K.NEON_MIN_CU} CU (upper bound)`),
    flow('neon', 'data_transfer_gb', m.api.bytes_out / 1e9, 'api_usage.bytes_out (responses are mostly rows read from Neon)'),

    flow('ably', 'messages', ablyMessages, 'usage_events:ably_publish × (active participants + 1) + presence'),
    level('ably', 'peak_connections', m.inventory.active_participants, 'session_participants where left_at is null'),
    level('ably', 'peak_channels', m.inventory.active_sessions, 'sessions where status = active'),

    flow('vercel', 'function_invocations', m.api.requests, 'api_usage rows'),
    flow('vercel', 'edge_requests', m.api.requests, 'api_usage rows (dashboard static requests are not counted here)'),
    flow('vercel', 'fast_data_transfer_gb', m.api.bytes_out / 1e9, 'api_usage.bytes_out'),
    flow('vercel', 'active_cpu_hours', durationHours * K.ACTIVE_CPU_FRACTION, `api_usage.duration_ms × ${K.ACTIVE_CPU_FRACTION} active-CPU share`),
    flow('vercel', 'provisioned_memory_gb_hours', durationHours * K.FUNCTION_MEMORY_GB, `api_usage.duration_ms × ${K.FUNCTION_MEMORY_GB} GB`),

    flow('bigquery', 'query_tib', e.bq_query.bytes / TIB, 'usage_events:bq_query bytes scanned'),
    level('bigquery', 'storage_gib_month', K.BQ_STORAGE_GIB, 'assumed billing-export size'),

    flow('cloud_run', 'vcpu_seconds', m.merges.seconds * K.MERGE_VCPU, 'merge_jobs duration'),
    flow('cloud_run', 'gib_seconds', m.merges.seconds * K.MERGE_GIB, 'merge_jobs duration'),
    flow('cloud_run', 'requests', m.merges.finished, 'merge_jobs finished'),

    flow('newrelic', 'ingest_gb', nrBytes / 1e9, 'usage_events:nr_push payload bytes'),
    level('newrelic', 'full_platform_users', K.NR_FULL_PLATFORM_USERS, 'assumed one full platform user'),

    flow('google_signin', 'sign_ins', m.api.google_sign_ins, 'api_usage rows for POST /v1/auth/google'),
    level('apple', 'membership_month', 1, 'fixed'),
  ]
}

export function caveatsFor(m: MeasuredUsage): string[] {
  const out = [
    'Ably counts only server publishes and presence: `pose` messages devices publish straight to Ably are invisible here, so the real message count is higher.',
    'Vercel edge requests count API calls only; requests the dashboard makes for its own static assets are billed to Vercel but never reach this API.',
    'GCS operations are counted as signed URLs minted, which is what the client then writes or reads — an unused URL overcounts and a retried upload undercounts.',
    `Active CPU is ${K.ACTIVE_CPU_FRACTION * 100}% of measured wall time and provisioned memory assumes ${K.FUNCTION_MEMORY_GB} GB per instance.`,
    `Neon compute is an upper bound: every request is assumed to keep the compute awake for ${K.NEON_AUTOSUSPEND_SECONDS}s at ${K.NEON_MIN_CU} CU.`,
  ]
  if (!m.storage.configured) out.push('Google Cloud Storage is not configured on this deployment, so stored bytes read as zero.')
  if (m.api.requests === 0) out.push('No requests were recorded in this window, so every flow metric reads as zero.')
  return out
}

/** Measured usage plus the monthly quantities and the caveats behind them. */
export async function usageFor(days: number): Promise<UsageResult> {
  const measured = await measureUsage(days)
  return { measured, quantities: quantitiesFrom(measured), caveats: caveatsFor(measured) }
}
