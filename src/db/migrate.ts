import { neon } from '@neondatabase/serverless'
import { databaseUrl } from '../env.js'
import { migrations } from './migrationSql.js'

/** Runs every bundled migration (all statements are idempotent `CREATE … IF NOT EXISTS`). */
export async function runMigrations(url: string = databaseUrl()): Promise<{ applied: { name: string; statements: number }[] }> {
  const sql = neon(url)
  const applied: { name: string; statements: number }[] = []
  for (const m of migrations) {
    const statements = m.sql.split(/;\s*\n/).map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean)
    for (const statement of statements) await sql(statement)
    applied.push({ name: m.name, statements: statements.length })
  }
  return { applied }
}
