// Applies src/db/migrations/*.sql in order using the Neon HTTP driver (one statement per request).
// Reads DATABASE_URL (or DATABASE_POSTGRES_URL / POSTGRES_URL) from the environment, .env.local or .env.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
}
const url = process.env.DATABASE_URL ?? process.env.DATABASE_POSTGRES_URL ?? process.env.POSTGRES_URL ?? process.env.DATABASE_DATABASE_URL
if (!url) { console.error('DATABASE_URL (or DATABASE_POSTGRES_URL / POSTGRES_URL) is required'); process.exit(1) }
const sql = neon(url)
const dir = join(process.cwd(), 'src/db/migrations')
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  const statements = readFileSync(join(dir, file), 'utf8')
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)
  for (const statement of statements) await sql(statement)
  console.log(`applied ${file} (${statements.length} statements)`)
}
console.log('migrations complete')
