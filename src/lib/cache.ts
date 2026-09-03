import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client.js'

/** Small JSON cache in Postgres so expensive upstream calls (bucket listing, catalog prices) are shared across instances. */
export async function cached<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<{ value: T; cached: boolean; updated_at: string }> {
  const [row] = await db().select().from(schema.statsCache).where(eq(schema.statsCache.key, key)).limit(1)
  if (row && Date.now() - row.updatedAt.getTime() < ttlSeconds * 1000) {
    return { value: row.value as T, cached: true, updated_at: row.updatedAt.toISOString() }
  }
  const value = await compute()
  const now = new Date()
  await db().insert(schema.statsCache).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.statsCache.key, set: { value, updatedAt: now } })
  return { value, cached: false, updated_at: now.toISOString() }
}
