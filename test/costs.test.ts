import { describe, expect, it } from 'vitest'
import {
  PRICING, billable, daysUntilExhausted, estimate, findPrice, summariseFreeTier, unverifiedEntries, usedPct,
  type PriceEntry, type QuantityInput,
} from '../src/lib/costs/index.js'
import { PROJECTION_CONSTANTS, project, projectQuantities, withDefaults, type ProjectionParams } from '../src/lib/costs/projection.js'
import { quantitiesFrom, type MeasuredUsage } from '../src/lib/costs/usage.js'

describe('pricing table', () => {
  it('gives every entry a price, a quota, a unit, a date and a source', () => {
    expect(PRICING.length).toBeGreaterThan(20)
    for (const p of PRICING) {
      expect(typeof p.unit_price_usd, `${p.provider}/${p.metric} unit_price_usd`).toBe('number')
      expect(Number.isFinite(p.unit_price_usd)).toBe(true)
      expect(p.unit_price_usd).toBeGreaterThanOrEqual(0)
      expect(typeof p.free_quota, `${p.provider}/${p.metric} free_quota`).toBe('number')
      expect(p.free_quota).toBeGreaterThanOrEqual(0)
      expect(p.unit.length, `${p.provider}/${p.metric} unit`).toBeGreaterThan(0)
      expect(p.as_of, `${p.provider}/${p.metric} as_of`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.source, `${p.provider}/${p.metric} source`).toMatch(/^https:\/\//)
      expect(typeof p.verified).toBe('boolean')
      expect(['flow', 'level']).toContain(p.kind)
      expect(p.label.length).toBeGreaterThan(0)
    }
  })

  it('has one entry per provider/metric pair', () => {
    const keys = PRICING.map((p) => `${p.provider}/${p.metric}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is reachable by provider and metric', () => {
    expect(findPrice('gcs', 'storage_gb_month')?.unit_price_usd).toBe(0.02)
    expect(findPrice('ably', 'messages')?.free_quota).toBe(6_000_000)
    expect(findPrice('vercel', 'function_invocations')?.free_quota).toBe(1_000_000)
    expect(findPrice('apple', 'membership_month')?.unit_price_usd).toBeCloseTo(8.25, 10)
    expect(findPrice('gcs', 'nonsense')).toBeUndefined()
  })

  it('names every entry whose number could not be read from the provider page', () => {
    const unverified = unverifiedEntries()
    for (const key of unverified) {
      const entry = PRICING.find((p) => `${p.provider}/${p.metric}` === key)
      expect(entry?.verified).toBe(false)
      expect(entry?.note, `${key} must say why it is unverified`).toBeTruthy()
    }
    // The Google pricing tables and Vercel's Hobby allowances are rendered client-side.
    expect(unverified).toContain('bigquery/query_tib')
    expect(unverified).toContain('vercel/fast_data_transfer_gb')
    expect(unverified).not.toContain('ably/messages')
  })
})

describe('engine arithmetic', () => {
  it('bills nothing up to the free quota and the excess after it', () => {
    expect(billable(0, 100)).toBe(0)
    expect(billable(99.999, 100)).toBe(0)
    expect(billable(100, 100)).toBe(0)          // the boundary itself is free
    expect(billable(100.001, 100)).toBeCloseTo(0.001, 10)
    expect(billable(250, 100)).toBe(150)
    expect(billable(5, 0)).toBe(5)              // no free quota: billable from the first unit
    expect(billable(-5, 100)).toBe(0)           // never negative
  })

  it('reports how full a free tier is', () => {
    expect(usedPct(50, 100)).toBe(50)
    expect(usedPct(100, 100)).toBe(100)
    expect(usedPct(300, 100)).toBe(300)
    expect(usedPct(1, 0)).toBeNull()            // no quota to be a percentage of
  })

  it('counts the days left before a free quota runs out', () => {
    expect(daysUntilExhausted(0, 100, 10)).toBe(10)
    expect(daysUntilExhausted(40, 100, 10)).toBe(6)
    expect(daysUntilExhausted(100, 100, 10)).toBe(0)   // exactly exhausted
    expect(daysUntilExhausted(140, 100, 10)).toBe(0)   // already over
    expect(daysUntilExhausted(0, 100, 0)).toBeNull()   // no rate to extrapolate
    expect(daysUntilExhausted(0, 0, 10)).toBeNull()    // nothing free to run out
  })

  const table: PriceEntry[] = [
    {
      provider: 'gcs', provider_label: 'Test', metric: 'class_a_ops', label: 'A', kind: 'flow', unit: 'operation',
      unit_price_usd: 0.001, free_quota: 1000, as_of: '2026-01-01', source: 'https://example.test/a', verified: true,
    },
    {
      provider: 'gcs', provider_label: 'Test', metric: 'storage_gb_month', label: 'S', kind: 'level', unit: 'GB-month',
      unit_price_usd: 0.02, free_quota: 5, as_of: '2026-01-01', source: 'https://example.test/s', verified: false,
    },
  ]

  it('prices a quantity set and totals it per provider', () => {
    const report = estimate([
      { provider: 'gcs', metric: 'class_a_ops', quantity: 3000, measured: 1500, daily_rate: 100 },
      { provider: 'gcs', metric: 'storage_gb_month', quantity: 9 },
      { provider: 'gcs', metric: 'not_a_metric', quantity: 1 },   // unknown pairs are ignored
    ], { pricing: table, window_days: 15 })

    const items = report.providers[0]?.items ?? []
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ billable_quantity: 2000, cost_usd: 2, used_pct: 300, days_until_free_exhausted: 0 })
    expect(items[1]).toMatchObject({ billable_quantity: 4, cost_usd: 0.08, used_pct: 180 })
    expect(report.providers[0]?.total_usd).toBe(2.08)
    expect(report.grand_total_usd).toBe(2.08)
    expect(report.monthly_run_rate_usd).toBe(2.08)
    expect(report.window_days).toBe(15)
    expect(report.unverified_metrics).toEqual(['gcs/storage_gb_month'])
    expect(report.actual).toEqual({ gcp: null })
  })

  it('leaves everything at zero when nothing has been used', () => {
    const report = estimate([
      { provider: 'gcs', metric: 'class_a_ops', quantity: 0, measured: 0, daily_rate: 0 },
      { provider: 'gcs', metric: 'storage_gb_month', quantity: 0 },
    ], { pricing: table })
    expect(report.grand_total_usd).toBe(0)
    expect(report.free_tier.used_pct_max).toBe(0)
    expect(report.free_tier.first_exhausted_metric).toBeUndefined()
  })

  it('picks the metric that runs out first, breaking ties on the fuller quota', () => {
    const report = estimate([
      { provider: 'gcs', metric: 'class_a_ops', quantity: 600, measured: 300, daily_rate: 100 },      // 7 days left
      { provider: 'gcs', metric: 'storage_gb_month', quantity: 4, daily_rate: 0.5 },                  // 2 days left
    ], { pricing: table })
    expect(report.free_tier).toEqual({
      used_pct_max: 80,
      first_exhausted_metric: 'gcs/storage_gb_month',
      days_until_paid_at_current_rate: 2,
    })
  })

  it('ignores always-billable metrics when naming the first free tier to go', () => {
    const items = estimate([{ provider: 'apple', metric: 'membership_month', quantity: 1 }]).providers[0]?.items ?? []
    expect(items[0]?.cost_usd).toBeCloseTo(8.25, 6)
    expect(items[0]?.used_pct).toBeNull()
    expect(summariseFreeTier(items)).toEqual({ used_pct_max: 0 })
  })
})

describe('projection', () => {
  /**
   * Worked example, every figure computed by hand from PROJECTION_CONSTANTS:
   *   2 mappers × 1 kf/s × 600 s                       = 1 200 keyframes per session
   *   × 1 session/day × 30 days                        = 36 000 keyframes per month
   *   36 000 blobs × 50 000 B + 30 maps × 10 MB        = 2.1 GB in GCS
   *   36 000 rows × (900 + 2 000 × 48) B + 30 × 2 000 B + 10 020 × 150 B = 3.489963 GB in Neon
   *   3 600 batches × 2 + 30 × 3 × 3 + 30 × 3 + 30 × 2 + 300 × 8         = 10 020 API requests
   */
  const params: ProjectionParams = {
    mappers: 2,
    sessions_per_day: 1,
    minutes_per_session: 10,
    keyframes_per_second: 1,
    depth_bytes_per_keyframe: 50_000,
    jpeg_every_n: 0,
    viewers_per_session: 1,
    map_size_mb: 10,
    maps_per_day: 1,
    retention_days: 30,
    dashboard_views_per_day: 10,
  }

  const quantityFor = (qs: QuantityInput[], provider: string, metric: string): number => {
    const q = qs.find((x) => x.provider === provider && x.metric === metric)
    if (!q) throw new Error(`missing quantity ${provider}/${metric}`)
    return q.quantity
  }

  it('derives the monthly quantities the worked example implies', () => {
    const q = projectQuantities(params)
    expect(quantityFor(q, 'gcs', 'storage_gb_month')).toBeCloseTo(2.1, 9)
    // 36 000 writes + 150 map files + 24 listings/day × 30 days × 37 pages of 1 000 objects
    expect(quantityFor(q, 'gcs', 'class_a_ops')).toBe(36_150 + 26_640)
    expect(quantityFor(q, 'gcs', 'class_b_ops')).toBe(900)
    expect(quantityFor(q, 'gcs', 'egress_gb')).toBeCloseTo(3, 9)
    expect(quantityFor(q, 'neon', 'storage_gb')).toBeCloseTo(3.489963, 9)
    // Every request keeps the compute awake 300 s, capped at always-on: 720 h × 0.25 CU
    expect(quantityFor(q, 'neon', 'compute_cu_hours')).toBe(180)
    // 3 600 keyframe messages + 2 mappers × 10 Hz × 600 s × 30 sessions + 180 presence, each × 4
    expect(quantityFor(q, 'ably', 'messages')).toBe((3_600 + 360_000 + 180) * 4)
    expect(quantityFor(q, 'vercel', 'function_invocations')).toBe(10_020)
    expect(quantityFor(q, 'vercel', 'edge_requests')).toBe(10_020 + 6_000)
    expect(quantityFor(q, 'vercel', 'fast_data_transfer_gb')).toBeCloseTo(0.19503, 9)
    expect(quantityFor(q, 'vercel', 'active_cpu_hours')).toBeCloseTo(250_500 / 3_600_000, 12)
    expect(quantityFor(q, 'vercel', 'provisioned_memory_gb_hours')).toBeCloseTo(0.334, 12)
    expect(quantityFor(q, 'cloud_run', 'vcpu_seconds')).toBe(3_600)
    expect(quantityFor(q, 'cloud_run', 'gib_seconds')).toBe(7_200)
    expect(quantityFor(q, 'newrelic', 'ingest_gb')).toBeCloseTo(0.0009, 12)
    expect(quantityFor(q, 'google_signin', 'sign_ins')).toBe(90)
    expect(quantityFor(q, 'apple', 'membership_month')).toBe(1)
  })

  it('prices the worked example to the cent', () => {
    const report = project(params)
    const provider = (id: string) => report.providers.find((p) => p.provider === id)
    // 57 790 billable Class A operations at $0.005/1 000
    expect(provider('gcs')?.total_usd).toBeCloseTo(0.28895, 9)
    // (3.489963 − 0.5) GB × $0.35 + (180 − 100) CU-hours × $0.106
    expect(provider('neon')?.total_usd).toBeCloseTo(1.046487 + 8.48, 6)
    expect(provider('apple')?.total_usd).toBeCloseTo(8.25, 6)
    for (const id of ['ably', 'vercel', 'bigquery', 'cloud_run', 'newrelic', 'google_signin']) {
      expect(provider(id)?.total_usd, `${id} should still be inside its free tier`).toBe(0)
    }
    expect(report.grand_total_usd).toBeCloseTo(18.065437, 6)
    expect(report.monthly_run_rate_usd).toBe(report.grand_total_usd)
  })

  it('names Neon storage as the first free tier to go, because of points_inline', () => {
    const report = project(params)
    expect(report.free_tier.first_exhausted_metric).toBe('neon/storage_gb')
    expect(report.free_tier.days_until_paid_at_current_rate).toBe(0)
    // The fullest quota is GCS Class A operations: 62 790 / 5 000 = 1 255.8 %
    expect(report.free_tier.used_pct_max).toBeCloseTo(1255.8, 4)
    // ...but Neon storage is already over, so it is the one that costs money first.
    const neonStorage = report.providers.find((x) => x.provider === 'neon')?.items.find((i) => i.metric === 'storage_gb')
    expect(neonStorage?.used_pct).toBeCloseTo(697.9926, 4)
    const keyframeRow = PROJECTION_CONSTANTS.KEYFRAME_ROW_BASE_BYTES +
      PROJECTION_CONSTANTS.INLINE_POINTS_PER_KEYFRAME * PROJECTION_CONSTANTS.INLINE_POINT_ROW_BYTES
    expect(keyframeRow).toBe(96_900)
  })

  it('scales linearly with the number of mappers', () => {
    const one = projectQuantities({ ...params, mappers: 1 })
    const two = projectQuantities({ ...params, mappers: 2 })
    expect(quantityFor(two, 'gcs', 'storage_gb_month') - 0.3).toBeCloseTo((quantityFor(one, 'gcs', 'storage_gb_month') - 0.3) * 2, 9)
  })

  it('charges nothing but Apple when there is no activity at all', () => {
    const idle = project({
      mappers: 0, sessions_per_day: 0, minutes_per_session: 0, keyframes_per_second: 0,
      depth_bytes_per_keyframe: 0, jpeg_every_n: 0, viewers_per_session: 0, map_size_mb: 0,
      maps_per_day: 0, retention_days: 0, dashboard_views_per_day: 0,
    })
    expect(idle.grand_total_usd).toBeCloseTo(8.25, 6)
  })

  it('fills in defaults and rejects nonsense without throwing', () => {
    expect(withDefaults()).toEqual(withDefaults({}))
    expect(withDefaults({ mappers: undefined }).mappers).toBe(withDefaults().mappers)
    expect(withDefaults({ mappers: -3 }).mappers).toBe(0)
    expect(withDefaults({ mappers: Number.NaN }).mappers).toBe(0)
    expect(withDefaults({ mappers: 7 }).mappers).toBe(7)
  })

  it('explains itself', () => {
    const { assumptions } = project(params)
    expect(assumptions.length).toBeGreaterThan(8)
    expect(assumptions.join(' ')).toContain('points_inline')
    expect(assumptions.join(' ')).toContain('$99/year')
  })
})

describe('measured usage → monthly quantities', () => {
  const measured: MeasuredUsage = {
    window_days: 15,
    since: '2026-08-20T00:00:00.000Z',
    api: { requests: 3_000, bytes_in: 0, bytes_out: 1.5e9, duration_ms: 3_600_000, google_sign_ins: 12 },
    events: {
      signed_upload: { count: 400, bytes: 0 },
      signed_download: { count: 60, bytes: 6e8 },
      keyframe_registered: { count: 900, bytes: 5e7 },
      ably_publish: { count: 90, bytes: 1000 },
      ably_token: { count: 20, bytes: 0 },
      bq_query: { count: 3, bytes: 1024 ** 4 / 2 },
      nr_push: { count: 240, bytes: 0 },
      gcs_list: { count: 100, bytes: 0 },
    },
    storage: { total_bytes: 4e9, total_objects: 1000, avg_object_bytes: 4e6, configured: true, cached: true, updated_at: null },
    database: { size_bytes: 2.5e8 },
    inventory: {
      keyframes: 900, keyframe_bytes: 5e7, maps: 4, map_bytes: 4e8, sessions: 6, active_sessions: 2,
      active_participants: 3, participant_joins: 10, participant_leaves: 8,
    },
    merges: { finished: 5, seconds: 600 },
  }

  const q = quantitiesFrom(measured)
  const find = (provider: string, metric: string) => {
    const hit = q.find((x) => x.provider === provider && x.metric === metric)
    if (!hit) throw new Error(`missing ${provider}/${metric}`)
    return hit
  }

  it('doubles a fifteen-day window into a thirty-day month for flow metrics', () => {
    expect(find('vercel', 'function_invocations').quantity).toBe(6_000)
    expect(find('vercel', 'function_invocations').measured).toBe(3_000)
    expect(find('vercel', 'function_invocations').daily_rate).toBe(200)
    expect(find('gcs', 'class_a_ops').quantity).toBe((400 + 100) * 2)
    expect(find('gcs', 'class_b_ops').quantity).toBe(120)
    expect(find('bigquery', 'query_tib').quantity).toBeCloseTo(1, 9)
  })

  it('passes level metrics through as measured', () => {
    expect(find('gcs', 'storage_gb_month')).toMatchObject({ quantity: 4, measured: 4, daily_rate: 0 })
    expect(find('neon', 'storage_gb')).toMatchObject({ quantity: 0.25, measured: 0.25 })
    expect(find('ably', 'peak_connections').quantity).toBe(3)
    expect(find('ably', 'peak_channels').quantity).toBe(2)
    expect(find('apple', 'membership_month').quantity).toBe(1)
  })

  it('fans Ably publishes out to every subscriber and adds presence', () => {
    // 90 publishes × (3 active participants + 1) + (10 joins + 8 leaves) × 4 = 360 + 72, doubled to a month
    expect(find('ably', 'messages').measured).toBe(432)
    expect(find('ably', 'messages').quantity).toBe(864)
  })

  it('splits function wall time into Active CPU and provisioned memory', () => {
    expect(find('vercel', 'active_cpu_hours').quantity).toBeCloseTo(1 * 0.35 * 2, 9)
    expect(find('vercel', 'provisioned_memory_gb_hours').quantity).toBeCloseTo(2, 9)
  })

  it('bounds Neon compute by always-on', () => {
    // 3 000 requests × 300 s = 900 000 s, well under the 1 296 000 s window, so 250 h × 0.25 CU
    expect(find('neon', 'compute_cu_hours').measured).toBeCloseTo(62.5, 9)
    expect(find('neon', 'compute_cu_hours').quantity).toBeCloseTo(125, 9)
  })

  it('says where every number came from', () => {
    for (const item of q) expect(item.basis, `${item.provider}/${item.metric}`).toBeTruthy()
  })
})
