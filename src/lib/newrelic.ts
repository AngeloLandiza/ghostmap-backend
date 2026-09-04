import { env } from '../env.js'

export interface NRMetric {
  name: string
  type: 'gauge' | 'count' | 'summary'
  value: number | { count: number; sum: number; min: number; max: number }
  timestamp?: number
  'interval.ms'?: number
  attributes?: Record<string, string | number | boolean>
}

export interface NREvent { eventType: string; timestamp?: number; [k: string]: string | number | boolean | undefined }

const endpoints = {
  US: { metric: 'https://metric-api.newrelic.com/metric/v1', event: (acct: string) => `https://insights-collector.newrelic.com/v1/accounts/${acct}/events`, log: 'https://log-api.newrelic.com/log/v1' },
  EU: { metric: 'https://metric-api.eu.newrelic.com/metric/v1', event: (acct: string) => `https://insights-collector.eu01.nr-data.net/v1/accounts/${acct}/events`, log: 'https://log-api.eu.newrelic.com/log/v1' },
}

export const isNewRelicConfigured = (): boolean => Boolean(env().NEW_RELIC_LICENSE_KEY)

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; detail?: string }> {
  const key = env().NEW_RELIC_LICENSE_KEY
  if (!key) return { ok: false, status: 0, detail: 'NEW_RELIC_LICENSE_KEY not set' }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': key },
    body: JSON.stringify(body),
  })
  const text = (await res.text()).slice(0, 300)
  return { ok: res.ok, status: res.status, detail: res.ok ? undefined : `HTTP ${res.status}${text ? `: ${text}` : ''} — for the Metric/Event APIs use an INGEST-LICENSE key (not a User key) and make sure NEW_RELIC_REGION matches the account's data center` }
}

/** Sends dimensional metrics through the New Relic Metric API. */
export async function sendMetrics(metrics: NRMetric[], common: Record<string, string | number | boolean> = {}) {
  if (metrics.length === 0) return { ok: true, status: 204 }
  const now = Date.now()
  const e = env()
  return post(endpoints[e.NEW_RELIC_REGION].metric, [{
    common: { timestamp: now, attributes: { service: 'ghostmap-backend', environment: e.VERCEL_ENV ?? e.NODE_ENV, ...common } },
    metrics: metrics.map((m) => ({ ...m, timestamp: m.timestamp ?? now })),
  }])
}

/** Sends custom events (queryable with NRQL: `FROM GhostmapRequest SELECT …`). */
export async function sendEvents(events: NREvent[]) {
  const e = env()
  if (!e.NEW_RELIC_ACCOUNT_ID) return { ok: false, status: 0, detail: 'NEW_RELIC_ACCOUNT_ID not set' }
  if (events.length === 0) return { ok: true, status: 204 }
  return post(endpoints[e.NEW_RELIC_REGION].event(e.NEW_RELIC_ACCOUNT_ID), events.map((ev) => ({ timestamp: Date.now(), ...ev })))
}

export async function newRelicHealth(): Promise<{ ok: boolean; detail?: string }> {
  if (!isNewRelicConfigured()) return { ok: false, detail: 'not configured' }
  const r = await sendMetrics([{ name: 'ghostmap.health.ping', type: 'gauge', value: 1 }])
  return { ok: r.ok, detail: r.detail }
}
