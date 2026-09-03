import { Hono } from 'hono'

export const health = new Hono()

// Reads process.env directly so the health check works even before the deployment is fully configured.
health.get('/health', (c) => {
  const required = ['AUTH_JWT_SECRET', 'ADMIN_API_KEY', 'CLIENT_ACCESS_KEYS']
  const missing = required.filter((k) => !process.env[k])
  const hasDb = Boolean(process.env.DATABASE_URL ?? process.env.DATABASE_POSTGRES_URL ?? process.env.POSTGRES_URL ?? process.env.DATABASE_DATABASE_URL)
  if (!hasDb) missing.push('DATABASE_URL')
  return c.json({ ok: true, configured: missing.length === 0, missing_env: missing, service: 'ghostmap-backend', version: process.env.APP_VERSION ?? '0.1.0', region: process.env.VERCEL_REGION ?? 'local', time: new Date().toISOString() })
})
