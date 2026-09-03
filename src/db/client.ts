import { neon } from '@neondatabase/serverless'
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { databaseUrl } from '../env.js'
import * as schema from './schema.js'

let cached: NeonHttpDatabase<typeof schema> | undefined

/** Drizzle over Neon's HTTP driver: one short-lived HTTPS request per query, ideal for serverless. */
export function db(): NeonHttpDatabase<typeof schema> {
  if (!cached) cached = drizzle(neon(databaseUrl()), { schema })
  return cached
}

export { schema }
