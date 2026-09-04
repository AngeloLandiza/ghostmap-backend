/**
 * PLAN §3 — one table of providers and metrics with unit prices, free quotas, the date the number was
 * checked and the page it came from.
 *
 * Every entry was looked up on the provider's own pricing page on `as_of`. Where the page could not be
 * read programmatically (Google renders several pricing tables client-side) the entry carries
 * `verified: false` and a `note` saying where the number came from, so a reader knows which figures to
 * re-check before quoting them. Prices are US list prices in USD, excluding tax and any committed-use or
 * promotional discount.
 *
 * `free_quota` is always **per calendar month** except where the unit says otherwise, and it is the
 * amount that costs nothing; billing starts at `quantity - free_quota`.
 */

export type ProviderId =
  | 'gcs' | 'bigquery' | 'cloud_run' | 'google_signin'
  | 'vercel' | 'neon' | 'ably' | 'newrelic' | 'apple'

/**
 * `flow` metrics accumulate over a window (operations, requests, bytes transferred) and are normalised to
 * a 30-day month before billing. `level` metrics are a standing amount (bytes stored, peak connections)
 * and are billed as measured.
 */
export type MetricKind = 'flow' | 'level'

export interface PriceEntry {
  provider: ProviderId
  provider_label: string
  metric: string
  label: string
  kind: MetricKind
  /** Human-readable unit of one `quantity` (also the unit `unit_price_usd` applies to). */
  unit: string
  /** Price of one unit beyond `free_quota`, in USD. */
  unit_price_usd: number
  /** Units included at no charge per month. 0 means the metric is billable from the first unit. */
  free_quota: number
  /** Date (YYYY-MM-DD) the figure was checked against `source`. */
  as_of: string
  /** The provider's own page the figure came from. */
  source: string
  /** False when the official page could not be read and the number came from a secondary summary of it. */
  verified: boolean
  note?: string
}

const AS_OF = '2026-09-04'

/** Days in the billing month used to normalise flow metrics. */
export const MONTH_DAYS = 30

const GCS_FREE = 'https://cloud.google.com/free/docs/free-cloud-features'

export const PRICING: readonly PriceEntry[] = [
  // ---- Google Cloud Storage (Standard, us-east1) -------------------------------------------------
  {
    provider: 'gcs', provider_label: 'Google Cloud Storage', metric: 'storage_gb_month',
    label: 'Standard storage (us-east1)', kind: 'level', unit: 'GB-month',
    unit_price_usd: 0.020, free_quota: 5, as_of: AS_OF,
    source: 'https://cloud.google.com/storage/pricing-examples', verified: true,
    note: 'Always Free covers 5 GB-months of regional storage in us-east1, us-west1 or us-central1 only.',
  },
  {
    provider: 'gcs', provider_label: 'Google Cloud Storage', metric: 'class_a_ops',
    label: 'Class A operations (writes, lists)', kind: 'flow', unit: 'operation',
    unit_price_usd: 0.005 / 1000, free_quota: 5_000, as_of: AS_OF,
    source: 'https://cloud.google.com/storage/pricing-examples', verified: true,
    note: '$0.005 per 1,000 Class A operations on regional Standard storage; 5,000 free per month.',
  },
  {
    provider: 'gcs', provider_label: 'Google Cloud Storage', metric: 'class_b_ops',
    label: 'Class B operations (reads)', kind: 'flow', unit: 'operation',
    unit_price_usd: 0.0004 / 1000, free_quota: 50_000, as_of: AS_OF,
    source: 'https://cloud.google.com/storage/pricing-examples', verified: true,
    note: '$0.0004 per 1,000 Class B operations on Standard storage; 50,000 free per month.',
  },
  {
    provider: 'gcs', provider_label: 'Google Cloud Storage', metric: 'egress_gb',
    label: 'Data transfer out to the internet (North America)', kind: 'flow', unit: 'GB',
    unit_price_usd: 0.12, free_quota: 100, as_of: AS_OF,
    source: 'https://cloud.google.com/storage/pricing-examples', verified: true,
    note: 'First tier (0-1 TB/month) for the Americas; Always Free covers 100 GB/month out of North America (excluding China and Australia).',
  },

  // ---- BigQuery (US multi-region) ---------------------------------------------------------------
  {
    provider: 'bigquery', provider_label: 'BigQuery', metric: 'query_tib',
    label: 'On-demand analysis (bytes scanned)', kind: 'flow', unit: 'TiB scanned',
    unit_price_usd: 6.25, free_quota: 1, as_of: AS_OF,
    source: 'https://cloud.google.com/bigquery/pricing', verified: false,
    note: 'Free quota (1 TiB/month) confirmed on the Always Free page; the $6.25/TiB list price could not be read from the pricing page (client-rendered table) and comes from a secondary summary of it — re-check before quoting.',
  },
  {
    provider: 'bigquery', provider_label: 'BigQuery', metric: 'storage_gib_month',
    label: 'Active logical storage', kind: 'level', unit: 'GiB-month',
    unit_price_usd: 0.02, free_quota: 10, as_of: AS_OF,
    source: 'https://cloud.google.com/bigquery/pricing', verified: false,
    note: 'Free quota (10 GiB/month) confirmed on the Always Free page; the $0.02/GiB-month list price could not be read from the pricing page and comes from a secondary summary of it.',
  },

  // ---- Cloud Run Jobs (tier-1 region, e.g. us-central1) -----------------------------------------
  {
    provider: 'cloud_run', provider_label: 'Cloud Run Jobs', metric: 'vcpu_seconds',
    label: 'vCPU time', kind: 'flow', unit: 'vCPU-second',
    unit_price_usd: 0.000024, free_quota: 180_000, as_of: AS_OF,
    source: 'https://cloud.google.com/run/pricing', verified: false,
    note: 'Free quota (180,000 vCPU-seconds/month) confirmed on the Always Free page; the per-second rate could not be read from the pricing page and comes from a secondary summary of it.',
  },
  {
    provider: 'cloud_run', provider_label: 'Cloud Run Jobs', metric: 'gib_seconds',
    label: 'Memory time', kind: 'flow', unit: 'GiB-second',
    unit_price_usd: 0.0000025, free_quota: 360_000, as_of: AS_OF,
    source: 'https://cloud.google.com/run/pricing', verified: false,
    note: 'Free quota (360,000 GiB-seconds/month) confirmed on the Always Free page; the per-second rate comes from a secondary summary of the pricing page.',
  },
  {
    provider: 'cloud_run', provider_label: 'Cloud Run Jobs', metric: 'requests',
    label: 'Job executions / requests', kind: 'flow', unit: 'request',
    unit_price_usd: 0.40 / 1_000_000, free_quota: 2_000_000, as_of: AS_OF,
    source: 'https://cloud.google.com/run/pricing', verified: false,
    note: 'Free quota (2 million requests/month) confirmed on the Always Free page; $0.40 per million comes from a secondary summary of the pricing page.',
  },

  // ---- Google Sign-In ---------------------------------------------------------------------------
  {
    provider: 'google_signin', provider_label: 'Google Sign-In', metric: 'sign_ins',
    label: 'Sign in with Google', kind: 'flow', unit: 'sign-in',
    unit_price_usd: 0, free_quota: 0, as_of: AS_OF,
    source: 'https://developers.google.com/identity/gsi/web/guides/overview', verified: false,
    note: 'Google Identity Services publishes no usage price; treated as free. Listed so the provider appears in the report with an explicit zero.',
  },

  // ---- Vercel (Hobby today, Pro prices for the upgrade line) ------------------------------------
  {
    provider: 'vercel', provider_label: 'Vercel', metric: 'fast_data_transfer_gb',
    label: 'Fast Data Transfer (bandwidth)', kind: 'flow', unit: 'GB',
    unit_price_usd: 0.15, free_quota: 100, as_of: AS_OF,
    source: 'https://vercel.com/docs/pricing/regional-pricing/iad1', verified: false,
    note: 'Pro on-demand rate for iad1 ($0.15/GB) verified. The Hobby allowance of 100 GB/month is rendered client-side on vercel.com/docs/plans/hobby and could not be read — treat the quota as unconfirmed.',
  },
  {
    provider: 'vercel', provider_label: 'Vercel', metric: 'function_invocations',
    label: 'Function invocations', kind: 'flow', unit: 'invocation',
    unit_price_usd: 0.60 / 1_000_000, free_quota: 1_000_000, as_of: AS_OF,
    source: 'https://vercel.com/docs/functions/usage-and-pricing', verified: true,
    note: 'Hobby includes 1 million invocations per month; Pro bills $0.60 per million.',
  },
  {
    provider: 'vercel', provider_label: 'Vercel', metric: 'active_cpu_hours',
    label: 'Active CPU', kind: 'flow', unit: 'CPU-hour',
    unit_price_usd: 0.128, free_quota: 4, as_of: AS_OF,
    source: 'https://vercel.com/docs/functions/usage-and-pricing', verified: true,
    note: 'Hobby includes 4 CPU-hours per month; $0.128/hour in iad1, cle1 and pdx1.',
  },
  {
    provider: 'vercel', provider_label: 'Vercel', metric: 'provisioned_memory_gb_hours',
    label: 'Provisioned memory', kind: 'flow', unit: 'GB-hour',
    unit_price_usd: 0.0106, free_quota: 360, as_of: AS_OF,
    source: 'https://vercel.com/docs/functions/usage-and-pricing', verified: true,
    note: 'Hobby includes 360 GB-hours per month; $0.0106/GB-hour in iad1.',
  },
  {
    provider: 'vercel', provider_label: 'Vercel', metric: 'edge_requests',
    label: 'Edge requests', kind: 'flow', unit: 'request',
    unit_price_usd: 2.00 / 1_000_000, free_quota: 1_000_000, as_of: AS_OF,
    source: 'https://vercel.com/docs/pricing/regional-pricing/iad1', verified: false,
    note: 'Pro on-demand rate for iad1 ($2.00 per million) verified. The Hobby allowance of 1 million/month is rendered client-side and could not be read — treat the quota as unconfirmed.',
  },

  // ---- Neon (Free plan; Launch prices for the upgrade line) -------------------------------------
  {
    provider: 'neon', provider_label: 'Neon Postgres', metric: 'storage_gb',
    label: 'Database storage', kind: 'level', unit: 'GB-month',
    unit_price_usd: 0.35, free_quota: 0.5, as_of: AS_OF,
    source: 'https://neon.com/docs/introduction/plans', verified: true,
    note: 'Free plan includes 0.5 GB per project; Launch bills $0.35 per GB-month.',
  },
  {
    provider: 'neon', provider_label: 'Neon Postgres', metric: 'compute_cu_hours',
    label: 'Compute', kind: 'flow', unit: 'CU-hour',
    unit_price_usd: 0.106, free_quota: 100, as_of: AS_OF,
    source: 'https://neon.com/docs/introduction/plans', verified: true,
    note: 'Free plan includes 100 CU-hours per project per month; Launch bills $0.106 per CU-hour.',
  },
  {
    provider: 'neon', provider_label: 'Neon Postgres', metric: 'data_transfer_gb',
    label: 'Data transfer (egress)', kind: 'flow', unit: 'GB',
    unit_price_usd: 0.10, free_quota: 5, as_of: AS_OF,
    source: 'https://neon.com/docs/introduction/plans', verified: true,
    note: 'Free plan includes 5 GB per project per month; Launch bills $0.10 per GB beyond its 500 GB.',
  },

  // ---- Ably (Free package) ----------------------------------------------------------------------
  {
    provider: 'ably', provider_label: 'Ably', metric: 'messages',
    label: 'Messages (published + delivered)', kind: 'flow', unit: 'message',
    unit_price_usd: 2.50 / 1_000_000, free_quota: 6_000_000, as_of: AS_OF,
    source: 'https://ably.com/pricing', verified: true,
    note: 'Free package includes 6 M messages per month; paid packages bill $2.50 per million (less with volume discounts).',
  },
  {
    provider: 'ably', provider_label: 'Ably', metric: 'peak_connections',
    label: 'Peak concurrent connections', kind: 'level', unit: 'connection',
    unit_price_usd: 0, free_quota: 200, as_of: AS_OF,
    source: 'https://ably.com/pricing', verified: true,
    note: 'Free package caps peak concurrent connections at 200; exceeding it requires the Standard package ($29/month), so there is no per-unit overage price.',
  },
  {
    provider: 'ably', provider_label: 'Ably', metric: 'peak_channels',
    label: 'Peak concurrent channels', kind: 'level', unit: 'channel',
    unit_price_usd: 0, free_quota: 200, as_of: AS_OF,
    source: 'https://ably.com/pricing', verified: true,
    note: 'Free package caps peak concurrent channels at 200; exceeding it requires the Standard package ($29/month).',
  },

  // ---- New Relic (Free tier) --------------------------------------------------------------------
  {
    provider: 'newrelic', provider_label: 'New Relic', metric: 'ingest_gb',
    label: 'Data ingest', kind: 'flow', unit: 'GB',
    unit_price_usd: 0.40, free_quota: 100, as_of: AS_OF,
    source: 'https://newrelic.com/pricing', verified: true,
    note: '100 GB of ingest free every month; $0.40/GB beyond it on the Original data option ($0.60/GB on Data Plus).',
  },
  {
    provider: 'newrelic', provider_label: 'New Relic', metric: 'full_platform_users',
    label: 'Full platform users', kind: 'level', unit: 'user-month',
    unit_price_usd: 99, free_quota: 1, as_of: AS_OF,
    source: 'https://newrelic.com/pricing', verified: true,
    note: 'One full platform user and unlimited basic users are free; additional full users cost $99/month on the Standard edition.',
  },

  // ---- Apple Developer Program ------------------------------------------------------------------
  {
    provider: 'apple', provider_label: 'Apple Developer Program', metric: 'membership_month',
    label: 'Membership ($99 per year, billed annually)', kind: 'level', unit: 'membership-month',
    unit_price_usd: 99 / 12, free_quota: 0, as_of: AS_OF,
    source: 'https://developer.apple.com/programs/enroll/', verified: true,
    note: '$99 per membership year; spread over twelve months so the monthly run rate is honest. Always billable — shipping to devices requires it.',
  },
]

/** Every entry, newest verification first in file order. */
export function pricingTable(): readonly PriceEntry[] { return PRICING }

const index = new Map(PRICING.map((p) => [`${p.provider}/${p.metric}`, p]))

export function findPrice(provider: ProviderId, metric: string): PriceEntry | undefined {
  return index.get(`${provider}/${metric}`)
}

/** Entries whose numbers could not be read from the provider's own page. */
export function unverifiedEntries(table: readonly PriceEntry[] = PRICING): string[] {
  return table.filter((p) => !p.verified).map((p) => `${p.provider}/${p.metric}`)
}

export const PROVIDER_LABELS: Record<ProviderId, string> = PRICING.reduce((acc, p) => {
  acc[p.provider] = p.provider_label
  return acc
}, {} as Record<ProviderId, string>)

/** Provider order used in reports (roughly "most likely to cost money" first). */
export const PROVIDER_ORDER: readonly ProviderId[] = ['gcs', 'neon', 'ably', 'vercel', 'bigquery', 'cloud_run', 'newrelic', 'google_signin', 'apple']
