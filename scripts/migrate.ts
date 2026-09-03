// CLI migration: reads DATABASE_URL (or the Vercel/Neon integration names) from the environment, .env.local or .env.
import { existsSync, readFileSync } from 'node:fs'
import { runMigrations } from '../src/db/migrate.js'

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
const url = process.env.DATABASE_URL ?? process.env.DATABASE_POSTGRES_URL ?? process.env.POSTGRES_URL ?? process.env.DATABASE_DATABASE_URL
if (!url) { console.error('DATABASE_URL (or DATABASE_POSTGRES_URL / POSTGRES_URL) is required'); process.exit(1) }
const result = await runMigrations(url)
for (const a of result.applied) console.log(`applied ${a.name} (${a.statements} statements)`)
console.log('migrations complete')
