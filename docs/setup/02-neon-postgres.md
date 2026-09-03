# 2. Neon Postgres

## What it stores
Devices, maps (metadata and file inventory; bytes live in GCS), sessions and participants, keyframe metadata, markers, merge jobs, `api_usage` (network stats) and a small stats cache.

## Steps
1. neon.tech → New project → region close to your Vercel region (e.g. `us-east-1` for `iad1`). Postgres 16.
2. Either connect Neon through Vercel → Storage → **Create Database** (the integration adds `DATABASE_URL`, `DATABASE_POSTGRES_URL`, … to the project automatically), or copy the **pooled** connection string (`…-pooler.…neon.tech`, `sslmode=require`) into `DATABASE_URL` yourself.
3. Create the tables — pick one:
   - From the deployment (no connection string needed; the SQL ships inside the function):
     ```bash
     curl -X POST https://<app>.vercel.app/admin/db/migrate -H "Authorization: Bearer $ADMIN_API_KEY"
     ```
   - Locally: `vercel env pull .env.local && npm run db:migrate` (reads `DATABASE_URL` or the Vercel/Neon integration's `DATABASE_POSTGRES_URL`).
   - Or paste `src/db/migrations/0001_init.sql` into the Vercel → Storage → Neon → **Query** tab (asks for your 2FA code).
   All statements are `CREATE … IF NOT EXISTS`, so re-running is safe.
4. Verify: `curl https://<app>/admin/overview -H "Authorization: Bearer $ADMIN_API_KEY"`.

## Notes
- The app uses Neon's HTTP driver (one HTTPS request per query) which suits Vercel functions; no connection pool to manage.
- `api_usage` grows by one row per request. Add a retention job later (e.g. `DELETE FROM api_usage WHERE ts < now() - interval '90 days'` via Vercel Cron or a Neon scheduled query).
- Neon's free tier scales to zero; the first request after idle takes ~0.5 s.
