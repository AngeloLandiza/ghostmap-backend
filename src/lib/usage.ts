import type { MiddlewareHandler } from 'hono'
import { waitUntil } from '@vercel/functions'
import { db, schema } from '../db/client.js'

/** Records one row per request in `api_usage` (route, status, latency, bytes, region, country, role). */
export const usageRecorder: MiddlewareHandler = async (c, next) => {
  const started = performance.now()
  await next()
  try {
    record(c, Math.round(performance.now() - started))
  } catch (e) {
    console.error('usage recorder skipped', e)
  }
}

function record(c: Parameters<MiddlewareHandler>[0], durationMs: number): void {
  const principal = c.get('principal')
  const row = {
    method: c.req.method,
    route: c.req.routePath || new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs,
    bytesIn: Number(c.req.header('x-request-bytes') ?? c.req.header('content-length') ?? 0),
    bytesOut: Number(c.res.headers.get('content-length') ?? 0),
    region: process.env.VERCEL_REGION ?? 'local',
    country: c.req.header('x-vercel-ip-country') ?? null,
    role: principal?.role ?? null,
    deviceId: principal?.deviceId ?? null,
  }
  const write = db().insert(schema.apiUsage).values(row).then(() => undefined).catch((e) => console.error('usage insert failed', e))
  try { waitUntil(write) } catch { void write }
}
