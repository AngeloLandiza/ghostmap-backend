import { Hono } from 'hono'
import { env } from '../env.js'

export const health = new Hono()

health.get('/health', (c) => {
  const e = env()
  return c.json({ ok: true, service: 'ghostmap-backend', version: e.APP_VERSION, region: e.VERCEL_REGION ?? 'local', time: new Date().toISOString() })
})
