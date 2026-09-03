// Applies src/db/migrations/*.sql in order using the Neon HTTP driver (one statement per request).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { neon } from '@neondatabase/serverless'

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL is required'); process.exit(1) }
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
