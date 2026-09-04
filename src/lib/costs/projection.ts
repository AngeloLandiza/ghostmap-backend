/**
 * PLAN §3 — the "what if" calculator: describe a month of Ghostmap activity and get the same cost report
 * the measured endpoint returns, plus the list of assumptions the arithmetic rests on.
 *
 * Every constant below is a stated assumption rather than a measurement; they are exported so tests (and
 * docs/COSTS.md) can quote the same numbers.
 */
import { estimate, type CostReport, type QuantityInput } from './engine.js'
import { MONTH_DAYS } from './pricing.js'

export interface ProjectionParams {
  /** Phones capturing at the same time in one party. */
  mappers: number
  sessions_per_day: number
  minutes_per_session: number
  keyframes_per_second: number
  /** Compressed depth + confidence payload stored per keyframe. */
  depth_bytes_per_keyframe: number
  /** Store one JPEG every N keyframes; 0 stores none. */
  jpeg_every_n: number
  /** Browsers watching a party live (they publish presence, not keyframes). */
  viewers_per_session: number
  map_size_mb: number
  maps_per_day: number
  /** How long keyframe blobs, keyframe rows and finished maps are kept. */
  retention_days: number
  dashboard_views_per_day: number
}

export const PROJECTION_DEFAULTS: ProjectionParams = {
  mappers: 2,
  sessions_per_day: 2,
  minutes_per_session: 10,
  keyframes_per_second: 3,
  depth_bytes_per_keyframe: 55_000,
  jpeg_every_n: 0,
  viewers_per_session: 1,
  map_size_mb: 40,
  maps_per_day: 2,
  retention_days: 30,
  dashboard_views_per_day: 20,
}

/** Stated assumptions the projection cannot measure. Exported so the tests and docs use the same numbers. */
export const PROJECTION_CONSTANTS = {
  /** One capture-resolution JPEG. */
  JPEG_BYTES: 120_000,
  /** Keyframes per `POST /v1/sessions/:id/keyframes` (and per Ably `keyframes` message). */
  KEYFRAME_BATCH: 10,
  /** Files stored per finished map: manifest, keyframes.bin, cloud.ply, thumbnail, session.log. */
  MAP_FILES_PER_MAP: 5,
  /** Client-published `pose` messages per mapper per second (PLAN §2 caps this at 10 Hz). */
  POSE_HZ: 10,
  /** `points_inline` points a device sends with each keyframe (PLAN §5). */
  INLINE_POINTS_PER_KEYFRAME: 2_000,
  /** Bytes one inline xyz+rgb point occupies inside a jsonb array. */
  INLINE_POINT_ROW_BYTES: 48,
  /** Pose, intrinsics, refs and index overhead of one keyframe row without its inline points. */
  KEYFRAME_ROW_BASE_BYTES: 900,
  MAP_ROW_BYTES: 2_000,
  API_USAGE_ROW_BYTES: 150,
  /** Average JSON response of an API call. */
  API_RESPONSE_BYTES: 1_500,
  /** Bytes the dashboard shell (JS, CSS, fonts) costs on one uncached view. */
  DASHBOARD_PAGE_BYTES: 600_000,
  DASHBOARD_EDGE_REQUESTS_PER_VIEW: 20,
  DASHBOARD_API_REQUESTS_PER_VIEW: 8,
  /** GCS objects read to render one map page (manifest, cloud.ply, thumbnail). */
  OBJECTS_READ_PER_VIEW: 3,
  /** Active CPU actually burned by one function invocation. */
  ACTIVE_CPU_MS_PER_INVOCATION: 25,
  /** Wall time an instance stays provisioned for one invocation (I/O included). */
  WALL_MS_PER_INVOCATION: 120,
  /** `vercel.json` gives the function 1024 MB. */
  FUNCTION_MEMORY_GB: 1,
  /** Neon suspends an idle compute after five minutes, so one request keeps it awake that long. */
  NEON_AUTOSUSPEND_SECONDS: 300,
  /** Smallest Neon compute size. */
  NEON_MIN_CU: 0.25,
  MERGE_SECONDS_PER_SESSION: 120,
  MERGE_VCPU: 1,
  MERGE_GIB: 2,
  /** `/admin/costs` caches for an hour, so at most one BigQuery job per hour. */
  BQ_QUERIES_PER_DAY: 24,
  BQ_BYTES_PER_COST_QUERY: 100_000_000,
  /** Size of the billing export table BigQuery keeps for us. */
  BQ_STORAGE_GIB: 1,
  /** The Vercel cron pushes once a day. */
  NR_PUSHES_PER_DAY: 1,
  NR_METRICS_PER_PUSH: 120,
  NR_BYTES_PER_METRIC: 250,
  NR_FULL_PLATFORM_USERS: 1,
} as const

const C = PROJECTION_CONSTANTS

const TIB = 1024 ** 4
const GIB = 1024 ** 3

export interface Projection extends CostReport {
  params: ProjectionParams
  assumptions: string[]
  /** The monthly quantities the report was built from, for a dashboard that wants to show its working. */
  quantities: QuantityInput[]
}

/** Fills in the defaults for anything the caller left out and clamps nonsense to zero. */
export function withDefaults(partial: Partial<ProjectionParams> = {}): ProjectionParams {
  // An explicit `undefined` from a validated query must not knock out the default.
  const given = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined))
  const p = { ...PROJECTION_DEFAULTS, ...given } as ProjectionParams
  const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  return {
    mappers: nonNegative(p.mappers),
    sessions_per_day: nonNegative(p.sessions_per_day),
    minutes_per_session: nonNegative(p.minutes_per_session),
    keyframes_per_second: nonNegative(p.keyframes_per_second),
    depth_bytes_per_keyframe: nonNegative(p.depth_bytes_per_keyframe),
    jpeg_every_n: nonNegative(p.jpeg_every_n),
    viewers_per_session: nonNegative(p.viewers_per_session),
    map_size_mb: nonNegative(p.map_size_mb),
    maps_per_day: nonNegative(p.maps_per_day),
    retention_days: nonNegative(p.retention_days),
    dashboard_views_per_day: nonNegative(p.dashboard_views_per_day),
  }
}

/** Monthly quantities for one set of parameters — the arithmetic, with no pricing in sight. */
export function projectQuantities(params: ProjectionParams): QuantityInput[] {
  const p = params
  const days = MONTH_DAYS
  const basis = 'projection'

  const sessionsPerMonth = p.sessions_per_day * days
  const sessionSeconds = p.minutes_per_session * 60
  const keyframesPerSessionPerMapper = sessionSeconds * p.keyframes_per_second
  const keyframesPerSession = keyframesPerSessionPerMapper * p.mappers
  const keyframesPerMonth = keyframesPerSession * sessionsPerMonth
  const jpegShare = p.jpeg_every_n > 0 ? 1 / p.jpeg_every_n : 0
  const jpegsPerMonth = keyframesPerMonth * jpegShare
  const participants = p.mappers + p.viewers_per_session

  // ---- what is kept, at a steady state, for `retention_days` -------------------------------------
  const retainedKeyframes = keyframesPerSession * p.sessions_per_day * p.retention_days
  const retainedMaps = p.maps_per_day * p.retention_days
  const storedObjects = retainedKeyframes * (1 + jpegShare) + retainedMaps * C.MAP_FILES_PER_MAP
  const storedBytes =
    retainedKeyframes * (p.depth_bytes_per_keyframe + jpegShare * C.JPEG_BYTES) +
    retainedMaps * p.map_size_mb * 1e6

  // ---- API traffic --------------------------------------------------------------------------------
  const keyframeBatches = C.KEYFRAME_BATCH > 0 ? keyframesPerMonth / C.KEYFRAME_BATCH : 0
  const dashboardViews = p.dashboard_views_per_day * days
  const apiRequests =
    keyframeBatches * 2 +                                   // register + mint the batch's upload URLs
    sessionsPerMonth * participants * 3 +                   // create/join, keyframe catch-up, leave
    sessionsPerMonth * participants +                       // realtime token
    p.maps_per_day * days * 2 +                             // create + finalize
    dashboardViews * C.DASHBOARD_API_REQUESTS_PER_VIEW

  // ---- Google Cloud Storage -----------------------------------------------------------------------
  const gcsWrites = keyframesPerMonth + jpegsPerMonth + p.maps_per_day * days * C.MAP_FILES_PER_MAP
  const gcsListPages = Math.max(1, Math.ceil(storedObjects / 1000))
  const gcsListOps = 24 * days * gcsListPages
  const gcsReads = dashboardViews * C.OBJECTS_READ_PER_VIEW
  const gcsEgressGb = (dashboardViews * p.map_size_mb * 1e6) / 1e9

  // ---- Neon ---------------------------------------------------------------------------------------
  const keyframeRowBytes = C.KEYFRAME_ROW_BASE_BYTES + C.INLINE_POINTS_PER_KEYFRAME * C.INLINE_POINT_ROW_BYTES
  const neonBytes =
    retainedKeyframes * keyframeRowBytes +
    retainedMaps * C.MAP_ROW_BYTES +
    apiRequests * (days > 0 ? p.retention_days / days : 0) * C.API_USAGE_ROW_BYTES
  const neonAwakeSeconds = Math.min(days * 86400, apiRequests * C.NEON_AUTOSUSPEND_SECONDS)
  const neonCuHours = (neonAwakeSeconds / 3600) * C.NEON_MIN_CU
  const neonEgressGb = (sessionsPerMonth * p.viewers_per_session * keyframesPerSession * keyframeRowBytes) / 1e9

  // ---- Ably ---------------------------------------------------------------------------------------
  const fanout = participants + 1
  const ablyKeyframeMessages = keyframeBatches * fanout
  const ablyPoseMessages = p.mappers * C.POSE_HZ * sessionSeconds * sessionsPerMonth * fanout
  const ablyPresenceMessages = sessionsPerMonth * participants * 2 * fanout
  const ablyMessages = ablyKeyframeMessages + ablyPoseMessages + ablyPresenceMessages

  // ---- Vercel -------------------------------------------------------------------------------------
  const edgeRequests = apiRequests + dashboardViews * C.DASHBOARD_EDGE_REQUESTS_PER_VIEW
  const fastDataTransferGb = (apiRequests * C.API_RESPONSE_BYTES + dashboardViews * C.DASHBOARD_PAGE_BYTES) / 1e9
  const activeCpuHours = (apiRequests * C.ACTIVE_CPU_MS_PER_INVOCATION) / 3_600_000
  const memoryGbHours = (apiRequests * C.WALL_MS_PER_INVOCATION * C.FUNCTION_MEMORY_GB) / 3_600_000

  // ---- BigQuery, Cloud Run, New Relic, sign-in ----------------------------------------------------
  const bqTib = (C.BQ_QUERIES_PER_DAY * days * C.BQ_BYTES_PER_COST_QUERY) / TIB
  const merges = sessionsPerMonth
  const nrIngestGb = (C.NR_PUSHES_PER_DAY * days * C.NR_METRICS_PER_PUSH * C.NR_BYTES_PER_METRIC) / 1e9
  const signIns = sessionsPerMonth * participants

  const q = (provider: QuantityInput['provider'], metric: string, quantity: number): QuantityInput =>
    ({ provider, metric, quantity, basis })

  return [
    q('gcs', 'storage_gb_month', storedBytes / 1e9),
    q('gcs', 'class_a_ops', gcsWrites + gcsListOps),
    q('gcs', 'class_b_ops', gcsReads),
    q('gcs', 'egress_gb', gcsEgressGb),
    q('neon', 'storage_gb', neonBytes / 1e9),
    q('neon', 'compute_cu_hours', neonCuHours),
    q('neon', 'data_transfer_gb', neonEgressGb),
    q('ably', 'messages', ablyMessages),
    { provider: 'ably', metric: 'peak_connections', quantity: participants, measured: participants, basis },
    { provider: 'ably', metric: 'peak_channels', quantity: p.sessions_per_day > 0 ? 1 : 0, measured: p.sessions_per_day > 0 ? 1 : 0, basis },
    q('vercel', 'function_invocations', apiRequests),
    q('vercel', 'edge_requests', edgeRequests),
    q('vercel', 'fast_data_transfer_gb', fastDataTransferGb),
    q('vercel', 'active_cpu_hours', activeCpuHours),
    q('vercel', 'provisioned_memory_gb_hours', memoryGbHours),
    q('bigquery', 'query_tib', bqTib),
    { provider: 'bigquery', metric: 'storage_gib_month', quantity: C.BQ_STORAGE_GIB, measured: C.BQ_STORAGE_GIB, basis },
    q('cloud_run', 'vcpu_seconds', merges * C.MERGE_SECONDS_PER_SESSION * C.MERGE_VCPU),
    q('cloud_run', 'gib_seconds', merges * C.MERGE_SECONDS_PER_SESSION * C.MERGE_GIB),
    q('cloud_run', 'requests', merges),
    q('newrelic', 'ingest_gb', nrIngestGb),
    { provider: 'newrelic', metric: 'full_platform_users', quantity: C.NR_FULL_PLATFORM_USERS, measured: C.NR_FULL_PLATFORM_USERS, basis },
    q('google_signin', 'sign_ins', signIns),
    { provider: 'apple', metric: 'membership_month', quantity: 1, measured: 1, basis },
  ]
}

/** The assumptions behind `projectQuantities`, phrased for the dashboard's "assumptions" panel. */
export function assumptionsFor(p: ProjectionParams): string[] {
  const keyframeRowBytes = C.KEYFRAME_ROW_BASE_BYTES + C.INLINE_POINTS_PER_KEYFRAME * C.INLINE_POINT_ROW_BYTES
  return [
    `A month is ${MONTH_DAYS} days and activity is even across it.`,
    `Each mapper produces ${p.keyframes_per_second} keyframes per second for ${p.minutes_per_session} minutes per session, so ${p.minutes_per_session * 60 * p.keyframes_per_second} keyframes per mapper per session.`,
    `A keyframe stores ${p.depth_bytes_per_keyframe} bytes of compressed depth + confidence in GCS${p.jpeg_every_n > 0 ? `, plus one ${C.JPEG_BYTES}-byte JPEG every ${p.jpeg_every_n} keyframes` : ' and no JPEG'}.`,
    `Keyframes are registered ${C.KEYFRAME_BATCH} at a time, so one API call and one Ably message cover ${C.KEYFRAME_BATCH} keyframes.`,
    `Devices publish pose at ${C.POSE_HZ} Hz while capturing; Ably bills a published message once per publisher and once per subscriber, so every message counts ${p.mappers + p.viewers_per_session + 1} times.`,
    `Keyframe blobs, keyframe rows and finished maps are kept for ${p.retention_days} days and the estimate is the steady state that retention implies, not a first-month ramp.`,
    `A keyframe row in Postgres costs ${C.KEYFRAME_ROW_BASE_BYTES} B plus ${C.INLINE_POINTS_PER_KEYFRAME} inline points at ${C.INLINE_POINT_ROW_BYTES} B each — about ${Math.round(keyframeRowBytes / 1024)} KB per keyframe. This dominates Neon storage; dropping points_inline after a party ends removes almost all of it.`,
    `The Neon compute stays awake ${C.NEON_AUTOSUSPEND_SECONDS} s after each request at ${C.NEON_MIN_CU} CU, capped at always-on — an upper bound, since bursts of requests share one wake-up.`,
    `A function invocation burns ${C.ACTIVE_CPU_MS_PER_INVOCATION} ms of Active CPU and holds ${C.FUNCTION_MEMORY_GB} GB for ${C.WALL_MS_PER_INVOCATION} ms.`,
    `A dashboard view is ${C.DASHBOARD_API_REQUESTS_PER_VIEW} API calls, ${C.DASHBOARD_EDGE_REQUESTS_PER_VIEW} edge requests, ${Math.round(C.DASHBOARD_PAGE_BYTES / 1000)} KB of Vercel transfer and one ${p.map_size_mb} MB map downloaded from GCS.`,
    `One merge job per session runs ${C.MERGE_SECONDS_PER_SESSION} s on ${C.MERGE_VCPU} vCPU and ${C.MERGE_GIB} GiB of Cloud Run.`,
    `/admin/costs runs at most ${C.BQ_QUERIES_PER_DAY} BigQuery jobs a day (it caches for an hour) scanning ${Math.round(C.BQ_BYTES_PER_COST_QUERY / 1e6)} MB each, over a ${C.BQ_STORAGE_GIB} GiB billing export.`,
    `New Relic receives ${C.NR_PUSHES_PER_DAY} push a day of ${C.NR_METRICS_PER_PUSH} metrics at ${C.NR_BYTES_PER_METRIC} B each, with ${C.NR_FULL_PLATFORM_USERS} full platform user.`,
    'The Apple Developer Program ($99/year) is spread over twelve months and is always billable.',
    'List prices only: no committed-use discounts, promotional credits or tax.',
  ]
}

/** PLAN §3 `project(params)` — the calculator behind `GET /admin/costs/projection`. */
export function project(partial: Partial<ProjectionParams> = {}): Projection {
  const params = withDefaults(partial)
  const quantities = projectQuantities(params)
  const report = estimate(quantities, { window_days: null })
  return { ...report, params, assumptions: assumptionsFor(params), quantities }
}

export { GIB, TIB }
