import { GoogleAuth } from 'google-auth-library'
import { BigQuery } from '@google-cloud/bigquery'
import { env, gcpCredentials } from '../env.js'
import { AppError, notConfigured } from './errors.js'
import { recordUsageEvent } from './usageEvents.js'

let auth: GoogleAuth | undefined

function googleAuth(): GoogleAuth {
  if (!auth) {
    const credentials = gcpCredentials()
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'], ...(credentials ? { credentials } : {}) })
  }
  return auth
}

async function accessToken(): Promise<string> {
  const token = await googleAuth().getAccessToken()
  if (!token) throw new AppError('upstream_error', 'could not obtain a Google access token')
  return token
}

async function gapi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new AppError('upstream_error', `Google API ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

/** Cloud Billing Catalog service ids. */
export const BILLING_SERVICES = {
  storage: '95FF-2EF5-5EA1',   // Cloud Storage
  run: '152E-C115-5142',       // Cloud Run
  bigquery: '24E6-F17E-DEC6',
} as const
export type BillingService = keyof typeof BILLING_SERVICES

export interface SkuPrice {
  sku_id: string
  description: string
  category: string
  usage_type: string
  regions: string[]
  unit: string
  /** Tiered rates: each tier starts at `start_usage_amount` units. */
  tiers: { start_usage_amount: number; price_usd: number }[]
}

/** Public list prices from the Cloud Billing Catalog API, optionally filtered by region substring. */
export async function listSkuPrices(service: BillingService, region?: string): Promise<SkuPrice[]> {
  const out: SkuPrice[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`https://cloudbilling.googleapis.com/v1/services/${BILLING_SERVICES[service]}/skus`)
    url.searchParams.set('currencyCode', 'USD')
    url.searchParams.set('pageSize', '500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await gapi<{ skus?: any[]; nextPageToken?: string }>(url.toString())
    for (const sku of page.skus ?? []) {
      const regions: string[] = sku.serviceRegions ?? []
      if (region && !regions.some((r) => r.includes(region)) && !regions.includes('global')) continue
      const pricing = sku.pricingInfo?.[0]?.pricingExpression
      if (!pricing) continue
      out.push({
        sku_id: sku.skuId,
        description: sku.description,
        category: sku.category?.resourceFamily ?? '',
        usage_type: sku.category?.usageType ?? '',
        regions,
        unit: pricing.usageUnitDescription ?? pricing.usageUnit ?? '',
        tiers: (pricing.tieredRates ?? []).map((t: any) => ({
          start_usage_amount: Number(t.startUsageAmount ?? 0),
          price_usd: Number(t.unitPrice?.units ?? 0) + Number(t.unitPrice?.nanos ?? 0) / 1e9,
        })),
      })
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

export interface CostRow { day: string; service: string; cost_usd: number; credits_usd: number }

/** Actual spend from the BigQuery billing export (standard usage cost table). */
export async function queryCosts(days: number): Promise<{ rows: CostRow[]; total_usd: number; by_service: Record<string, number> }> {
  const e = env()
  if (!e.BILLING_EXPORT_TABLE) throw notConfigured('BigQuery billing export (BILLING_EXPORT_TABLE)')
  const credentials = gcpCredentials()
  const bq = new BigQuery({ projectId: e.GCP_PROJECT_ID, ...(credentials ? { credentials } : {}) })
  const query = `
    SELECT FORMAT_DATE('%F', DATE(usage_start_time)) AS day,
           service.description AS service,
           ROUND(SUM(cost), 4) AS cost_usd,
           ROUND(SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)), 4) AS credits_usd
    FROM \`${e.BILLING_EXPORT_TABLE}\`
    WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
    GROUP BY day, service ORDER BY day DESC, cost_usd DESC`
  // createQueryJob (rather than query) so the job's own statistics give us the bytes BigQuery billed.
  const [job] = await bq.createQueryJob({ query, params: { days } })
  const [rows] = await job.getQueryResults()
  const stats = (job.metadata as { statistics?: { query?: { totalBytesProcessed?: string | number } } } | undefined)?.statistics
  recordUsageEvent('bq_query', 1, Number(stats?.query?.totalBytesProcessed ?? 0))
  const typed = (rows as CostRow[]).map((r) => ({ ...r, cost_usd: Number(r.cost_usd), credits_usd: Number(r.credits_usd) }))
  const by_service: Record<string, number> = {}
  let total_usd = 0
  for (const r of typed) {
    const net = r.cost_usd + r.credits_usd
    by_service[r.service] = (by_service[r.service] ?? 0) + net
    total_usd += net
  }
  return { rows: typed, total_usd: Math.round(total_usd * 10000) / 10000, by_service }
}

/** Starts the Cloud Run merge job with the merge-job id as an argument. Returns the execution name. */
export async function runMergeJob(mergeJobId: string): Promise<string> {
  const e = env()
  if (!e.CLOUD_RUN_MERGE_JOB || !e.GCP_PROJECT_ID) throw notConfigured('Cloud Run merge job (CLOUD_RUN_MERGE_JOB)')
  const name = e.CLOUD_RUN_MERGE_JOB.startsWith('projects/')
    ? e.CLOUD_RUN_MERGE_JOB
    : `projects/${e.GCP_PROJECT_ID}/locations/${e.CLOUD_RUN_REGION}/jobs/${e.CLOUD_RUN_MERGE_JOB}`
  const res = await gapi<{ name?: string; metadata?: { name?: string } }>(`https://run.googleapis.com/v2/${name}:run`, {
    method: 'POST',
    body: JSON.stringify({ overrides: { containerOverrides: [{ args: ['--merge-job', mergeJobId] }] } }),
  })
  return res.metadata?.name ?? res.name ?? 'unknown'
}

export async function gcpHealth(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await accessToken()
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: String(e) }
  }
}
