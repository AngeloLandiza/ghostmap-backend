# 2. Neon Postgres

## What it stores
Devices, maps (metadata and file inventory; bytes live in GCS), sessions and participants, keyframe metadata, markers, merge jobs, `api_usage` (network stats) and a small stats cache.

## Steps
1. neon.tech → New project → region close to your Vercel region (e.g. `us-east-1` for `iad1`). Postgres 16.
2. Copy the **pooled** connection string (`…-pooler.…neon.tech`, `sslmode=require`) into `DATABASE_URL` locally and in Vercel.
3. Create the tables:
   ```bash
   npm run db:migrate          # runs src/db/migrations/*.sql with the Neon HTTP driver
   ```
   (or `psql "$DATABASE_URL" -f src/db/migrations/0001_init.sql`).
4. Verify: `curl https://<app>/admin/overview -H "Authorization: Bearer $ADMIN_API_KEY"`.

## Notes
- The app uses Neon's HTTP driver (one HTTPS request per query) which suits Vercel functions; no connection pool to manage.
- `api_usage` grows by one row per request. Add a retention job later (e.g. `DELETE FROM api_usage WHERE ts < now() - interval '90 days'` via Vercel Cron or a Neon scheduled query).
- Neon's free tier scales to zero; the first request after idle takes ~0.5 s.
