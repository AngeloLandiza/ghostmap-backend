# 7. Admin monitoring: GCP costs, pricing, storage, network → New Relic

## What this feature gives you
Admin-only endpoints (`ADMIN_API_KEY`):
- `GET /admin/network?hours=24` — request volume, error counts, p50/p95/p99 latency, bytes in/out, by route / Vercel region / visitor country / hour, from the `api_usage` table every request writes to.
- `GET /admin/storage` — bucket size and object counts per prefix.
- `GET /admin/costs?days=30` — actual GCP spend per day and service from the BigQuery billing export.
- `GET /admin/pricing?service=storage&region=us-east1` — list prices (tiered USD) from the Cloud Billing Catalog API.
- `GET /admin/health` — deep checks of Postgres, GCP credentials, Ably and New Relic.
- `GET|POST /admin/newrelic/push` — pushes all of the above as New Relic metrics plus a `GhostmapSnapshot` event; Vercel Cron runs it every 10 minutes.

## A. GCP pricing (Cloud Billing Catalog API)
```bash
gcloud services enable cloudbilling.googleapis.com
```
The service account only needs an access token (no extra role) to read public SKUs. Test: `curl "https://<app>/admin/pricing?service=storage&region=us-east1" -H "Authorization: Bearer $ADMIN_API_KEY"`.

## B. Actual costs (BigQuery billing export)
1. Console → Billing → **Billing export** → BigQuery export → enable *Standard usage cost* into a dataset (e.g. `billing` in project `ghostmap-prod`). Data starts flowing within a day; the table is named `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`.
2. Grant the API's service account read access:
   ```bash
   gcloud services enable bigquery.googleapis.com
   gcloud projects add-iam-policy-binding ghostmap-prod --member="serviceAccount:ghostmap-api@ghostmap-prod.iam.gserviceaccount.com" --role="roles/bigquery.jobUser"
   bq add-iam-policy-binding --member="serviceAccount:ghostmap-api@ghostmap-prod.iam.gserviceaccount.com" --role="roles/bigquery.dataViewer" ghostmap-prod:billing
   ```
3. Set `BILLING_EXPORT_TABLE=ghostmap-prod.billing.gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX` in Vercel. Test `GET /admin/costs?days=7`.
4. Optional guard rail: Billing → Budgets & alerts → a budget with email alerts at 50/90/100 %.

## C. New Relic
1. New Relic account → API keys → create an **Ingest – License** key → `NEW_RELIC_LICENSE_KEY`. Note your account id (`NEW_RELIC_ACCOUNT_ID`) and data-center region (`NEW_RELIC_REGION=US|EU`).
2. Redeploy, then trigger a push manually: `curl -X POST https://<app>/admin/newrelic/push -H "Authorization: Bearer $ADMIN_API_KEY"` → `{ sent: true, metrics: N }`.
3. Make sure `CRON_SECRET` is set so the scheduled cron can authenticate (guide 1).
4. **Optional agent-style telemetry**: install the **New Relic integration from the Vercel Marketplace** (Vercel → Integrations → New Relic). It forwards function logs and traces (OpenTelemetry) for every request without code changes, which complements the metrics this API pushes. If you prefer in-code tracing, add `@vercel/otel` with New Relic's OTLP endpoint (`https://otlp.nr-data.net:4318`, header `api-key: <license key>`) in `instrumentation.ts`.
5. Dashboards — NRQL you can paste:
   ```sql
   -- requests and errors per hour
   SELECT latest(ghostmap.api.requests), latest(ghostmap.api.errors.server) FROM Metric WHERE service = 'ghostmap-backend' TIMESERIES 1 hour
   -- latency
   SELECT latest(ghostmap.api.latency.p95_ms), latest(ghostmap.api.latency.p50_ms) FROM Metric TIMESERIES AUTO
   -- slowest routes
   SELECT latest(ghostmap.api.route.p95_ms) FROM Metric FACET route, method LIMIT 20
   -- traffic by country / region
   SELECT latest(ghostmap.api.country.requests) FROM Metric FACET country
   -- storage and spend
   SELECT latest(ghostmap.gcs.bytes)/1e9 AS 'GB stored', latest(ghostmap.gcp.cost.30d_usd) AS 'USD 30d' FROM Metric
   SELECT latest(ghostmap.gcp.cost.service_30d_usd) FROM Metric FACET gcp_service
   -- snapshot events
   FROM GhostmapSnapshot SELECT * SINCE 1 day ago
   ```
   Set alert conditions on `ghostmap.api.errors.server`, `ghostmap.api.latency.p95_ms` and `ghostmap.gcp.cost.latest_day_usd`.

## Notes
- Bucket stats list every object; results are cached 10 minutes in Postgres. Above a few hundred thousand objects, switch to Cloud Monitoring's `storage.googleapis.com/storage/total_bytes` metric instead.
- `api_usage` rows are written after the response with `waitUntil`, so recording never slows a request.
