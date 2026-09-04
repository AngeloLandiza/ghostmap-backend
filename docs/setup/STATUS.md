# Provisioning status (updated 2026-09-04)

| Item | State | Value / location |
|---|---|---|
| Vercel project | deployed, healthy | https://ghostmap-backend.vercel.app (`/health` → `configured: true`) |
| Neon Postgres | connected via Vercel Storage, schema migrated (15 statements) | `DATABASE_URL` and `DATABASE_*` variables set by the integration |
| App secrets | set by owner | `AUTH_JWT_SECRET`, `ADMIN_API_KEY`, `CLIENT_ACCESS_KEYS`, `WORKER_API_KEY`, `CRON_SECRET`, `ALLOWED_ORIGINS` |
| GCP project | reused (quota exhausted for new projects) | `gen-lang-client-0241212583` ("SparkHacks 26'"), billing account `01B0E9-B53277-8503B0` |
| APIs enabled | done | storage, iam, cloudbilling, bigquery, run, cloudresourcemanager |
| GCS bucket | created, verified with a signed upload/download | `gs://ghostmap-maps-0241212583` (US-EAST1, uniform access, public access prevention, CORS for localhost:5173/3000 and ghostmap.vercel.app, 30-day lifecycle on `sessions/`) |
| Service account | created, key issued | `ghostmap-api@gen-lang-client-0241212583.iam.gserviceaccount.com` — roles: storage.objectAdmin (bucket), bigquery.jobUser, bigquery.dataViewer, run.developer |
| BigQuery billing export | standard usage cost export enabled | dataset `gen-lang-client-0241212583.billing`, table `gcp_billing_export_v1_01B0E9_B53277_8503B0` (rows appear within ~24 h) |
| Cloud Billing Catalog | verified (210 storage SKUs for us-east1) | via the service account |
| Vercel env (non-secret) | updated | `GCP_PROJECT_ID`, `GCS_BUCKET`, `BILLING_EXPORT_TABLE`, `CLOUD_RUN_REGION=us-east1`, `NEW_RELIC_ACCOUNT_ID=8469025`, `NEW_RELIC_REGION=US` |
| `GCP_SA_KEY_B64` | set (Production) | `/admin/storage` and `/health` report `gcp: ok` |
| `ABLY_API_KEY` | set (Production + Preview) | Ably app "ghostmap"; `/health` reports `ably: ok` |
| `NEW_RELIC_LICENSE_KEY` | set by owner; **verify** with the push below (`sent: true`) | must be an INGEST-LICENSE key, not a USER key (a USER key gives 403 from both APIs) |
| Cloud Run merge job | not created (needs the worker image; see 05-merge-worker.md) | `CLOUD_RUN_MERGE_JOB` stays empty → jobs queue for a pull worker |
| Cron | daily at 08:00 UTC (`vercel.json`), Hobby plan limit | `GET /admin/newrelic/push` with `CRON_SECRET` |

After the three pending values are applied, redeploy (`vercel --prod` or push a commit) and verify:

```bash
curl https://ghostmap-backend.vercel.app/admin/health -H "Authorization: Bearer $ADMIN_API_KEY"
curl https://ghostmap-backend.vercel.app/admin/storage -H "Authorization: Bearer $ADMIN_API_KEY"
curl "https://ghostmap-backend.vercel.app/admin/pricing?service=storage&region=us-east1" -H "Authorization: Bearer $ADMIN_API_KEY" | head -c 400
curl -X POST https://ghostmap-backend.vercel.app/admin/newrelic/push -H "Authorization: Bearer $ADMIN_API_KEY"
```

## Phase 2 additions (2026-09-04)

| Item | State | Value / location |
|---|---|---|
| Google OAuth consent screen | External, **Testing**, app "Ghostmap" (project `gen-lang-client-0241212583`) | Test user: the owner's Google account only; other accounts are rejected by Google until the app is published |
| OAuth clients | created | "Ghostmap Dashboard" (web; origins `http://localhost:5173`, `https://ghostmap-dashboard.vercel.app`) and "Ghostmap iOS" (iOS, bundle id of the app). IDs and the iOS URL scheme are in `.secrets/google-oauth.env` |
| `GOOGLE_CLIENT_IDS`, `DASHBOARD_URL` | set (Production + Preview) | `POST /v1/auth/google` answers 401 (not 501) for a bad token, which proves the audience list is live |
| Dashboard | Vercel project `ghostmap-dashboard` (Vite, root `/`) | https://ghostmap-dashboard.vercel.app; env `VITE_API_BASE`, `VITE_GOOGLE_CLIENT_ID`; `ALLOWED_ORIGINS` already includes it (preflight verified) |
| Migrations 0002 + 0003 | **pending** — owner runs once after deploy | `curl -X POST https://ghostmap-backend.vercel.app/admin/db/migrate -H "Authorization: Bearer $ADMIN_API_KEY"` (idempotent; creates `users`, party columns, `usage_events`). Until then `/v1/auth/google` logins and `/admin/costs/{overview,usage}` fail with 500 |
| Backend E2E suite | written (`npm run test:e2e`, 17 tests, skipped without secrets) | run locally with `E2E_BASE_URL`, `E2E_ADMIN_API_KEY`, `E2E_CLIENT_ACCESS_KEY` exported, or add the same three as GitHub Actions secrets to enable the `e2e` CI job |
| GCS bucket CORS | must include the dashboard origin so the browser viewer can fetch signed PLY URLs | see `.secrets/cors.json` and 02-gcs.md |
