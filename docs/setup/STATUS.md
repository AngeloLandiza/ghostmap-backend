# Provisioning status (2026-09-03)

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
| `GCP_SA_KEY_B64` | **pending** — value in `.secrets/ghostmap-backend.gcp.env` on the owner's Mac | apply with `scripts/vercel-env-apply.sh .secrets/ghostmap-backend.gcp.env` after `vercel login && vercel link` |
| `ABLY_API_KEY` | **pending** — owner must log in to ably.com, create app "ghostmap" and a key (publish, subscribe, presence, history) | add to `.secrets/ghostmap-backend.extra.env`, apply with the same script |
| `NEW_RELIC_LICENSE_KEY` | **pending** — existing INGEST-LICENSE key on account 8469025 (one.newrelic.com → API keys → … → Copy key) | same |
| Cloud Run merge job | not created (needs the worker image; see 05-merge-worker.md) | `CLOUD_RUN_MERGE_JOB` stays empty → jobs queue for a pull worker |
| Cron | daily at 08:00 UTC (`vercel.json`), Hobby plan limit | `GET /admin/newrelic/push` with `CRON_SECRET` |

After the three pending values are applied, redeploy (`vercel --prod` or push a commit) and verify:

```bash
curl https://ghostmap-backend.vercel.app/admin/health -H "Authorization: Bearer $ADMIN_API_KEY"
curl https://ghostmap-backend.vercel.app/admin/storage -H "Authorization: Bearer $ADMIN_API_KEY"
curl "https://ghostmap-backend.vercel.app/admin/pricing?service=storage&region=us-east1" -H "Authorization: Bearer $ADMIN_API_KEY" | head -c 400
curl -X POST https://ghostmap-backend.vercel.app/admin/newrelic/push -H "Authorization: Bearer $ADMIN_API_KEY"
```
