// Regenerates src/db/migrationSql.ts from src/db/migrations/*.sql so the SQL ships inside the serverless bundle.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = join(process.cwd(), 'src/db/migrations')
const entries = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
  const sql = readFileSync(join(dir, name), 'utf8').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
  return `  { name: '${name}', sql: \`${sql}\` },`
})
writeFileSync(join(process.cwd(), 'src/db/migrationSql.ts'), `// Generated from src/db/migrations/*.sql by \`npm run db:sync\` — do not edit by hand.\nexport const migrations: { name: string; sql: string }[] = [\n${entries.join('\n')}\n]\n`)
console.log(`synced ${entries.length} migration(s)`)
