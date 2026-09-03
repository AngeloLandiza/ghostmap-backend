import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_VERSION: z.string().default('0.1.0'),
  AUTH_JWT_SECRET: z.string().min(16),
  ADMIN_API_KEY: z.string().min(8),
  CLIENT_ACCESS_KEYS: z.string().default(''),
  WORKER_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  ALLOWED_ORIGINS: z.string().default(''),
  // Any of these may carry the Neon connection string (Vercel's Neon integration names them with a prefix).
  DATABASE_URL: z.string().optional(),
  DATABASE_POSTGRES_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  DATABASE_DATABASE_URL: z.string().optional(),
  GCP_PROJECT_ID: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  GCP_SA_KEY_B64: z.string().optional(),
  BILLING_EXPORT_TABLE: z.string().optional(),
  CLOUD_RUN_REGION: z.string().default('us-central1'),
  CLOUD_RUN_MERGE_JOB: z.string().optional(),
  ABLY_API_KEY: z.string().optional(),
  NEW_RELIC_LICENSE_KEY: z.string().optional(),
  NEW_RELIC_ACCOUNT_ID: z.string().optional(),
  NEW_RELIC_REGION: z.enum(['US', 'EU']).default('US'),
  VERCEL_REGION: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | undefined

/** Validated process environment. Throws with a readable message when a required variable is missing. */
export function env(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid environment: ${issues}`)
  }
  cached = parsed.data
  return cached
}

/** The Postgres connection string from whichever variable the deployment provides. */
export function databaseUrl(): string {
  const e = env()
  const url = e.DATABASE_URL ?? e.DATABASE_POSTGRES_URL ?? e.POSTGRES_URL ?? e.DATABASE_DATABASE_URL
  if (!url) throw new Error('Invalid environment: DATABASE_URL (or DATABASE_POSTGRES_URL / POSTGRES_URL) is required')
  return url
}

export function clientAccessKeys(): string[] {
  return env().CLIENT_ACCESS_KEYS.split(',').map((s) => s.trim()).filter(Boolean)
}

export function allowedOrigins(): string[] {
  return env().ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Service-account credentials decoded from GCP_SA_KEY_B64, or undefined when not configured. */
export function gcpCredentials(): Record<string, string> | undefined {
  const b64 = env().GCP_SA_KEY_B64
  if (!b64) return undefined
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, string>
  } catch {
    throw new Error('GCP_SA_KEY_B64 is not valid base64 JSON')
  }
}
