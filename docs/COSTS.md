# Costs

"See all the costs" (PLAN §3). Four admin endpoints answer three different questions:

| Question | Endpoint |
|---|---|
| What did we actually use? | `GET /admin/costs/usage?days=30` |
| What would that cost for a month? | `GET /admin/costs/overview?days=30` |
| What are the list prices and free tiers? | `GET /admin/costs/pricing` |
| What would *this* amount of activity cost? | `GET /admin/costs/projection?<params>` |

`GET /admin/costs` is unchanged: it is the **actual** spend from the BigQuery billing export, and it is
also folded into the overview as `actual.gcp`.

Code: `src/lib/costs/{pricing,usage,engine,projection}.ts`, counters in `src/lib/usageEvents.ts`.

## The model

Every metric has a monthly free quota and a price for the units beyond it:

```
billable = max(0, monthly_quantity − free_quota)
cost_usd = billable × unit_price_usd
```

Metrics come in two shapes. A **flow** accumulates over time (operations, requests, bytes transferred,
messages) and a window of `days` is scaled to a 30-day month by `× 30 / days`. A **level** is a standing
amount (bytes stored, peak connections, database size) and is billed as measured. `kind` on every price
entry says which.

Two derived numbers per provider and once for the whole report:

- `used_pct` — how full a free tier is, `100 × quantity / free_quota`; `null` when there is no free quota.
- `days_until_paid_at_current_rate` — `(free_quota − consumed) / daily_rate`, i.e. how long the free tier
  lasts at today's pace. `0` means the quota is already gone; `null` means there is no rate to
  extrapolate from (a level metric that is not yet over). `first_exhausted_metric` is the metric with the
  fewest days left, ties broken by the fuller quota. Always-billable metrics (the Apple membership) are
  never named here — they have no free tier to run out.

`grand_total_usd` and `monthly_run_rate_usd` are the same figure: the bill for one 30-day month at the
measured or projected rate. `window_days` says how much measurement is behind it (`null` for a
projection).

## How each quantity is measured

`usage.ts` reads five sources. `basis` on every quantity records which one it came from.

| Provider / metric | Where the number comes from |
|---|---|
| `gcs/storage_gb_month` | `bucketStats()` total bytes, cached 10 minutes in `stats_cache` |
| `gcs/class_a_ops` | `usage_events` `signed_upload` + `gcs_list` — one minted upload URL is one object the client then writes |
| `gcs/class_b_ops` | `usage_events` `signed_download` |
| `gcs/egress_gb` | `signed_download` bytes when known, otherwise downloads × average object size |
| `bigquery/query_tib` | `usage_events` `bq_query` bytes, read from each job's own `totalBytesProcessed` |
| `bigquery/storage_gib_month` | assumed 1 GiB of billing export |
| `cloud_run/*` | `merge_jobs` durations (`finished_at − started_at`), at 1 vCPU and 2 GiB |
| `vercel/function_invocations`, `edge_requests` | one `api_usage` row per request |
| `vercel/fast_data_transfer_gb` | `sum(api_usage.bytes_out)` |
| `vercel/active_cpu_hours` | `sum(duration_ms)` × 0.35 (the share of wall time that is CPU rather than I/O) |
| `vercel/provisioned_memory_gb_hours` | `sum(duration_ms)` × 1 GB (the function's configured memory) |
| `neon/storage_gb` | `pg_database_size(current_database())` |
| `neon/compute_cu_hours` | requests × 300 s autosuspend × 0.25 CU, capped at always-on — an **upper bound** |
| `neon/data_transfer_gb` | `sum(api_usage.bytes_out)`: responses are mostly rows read from Neon |
| `ably/messages` | `usage_events` `ably_publish` × (active participants + 1) + presence events |
| `ably/peak_connections`, `peak_channels` | active participants and active sessions right now |
| `newrelic/ingest_gb` | `usage_events` `nr_push` payload bytes (≈ 250 B per metric) |
| `newrelic/full_platform_users` | assumed 1 |
| `google_signin/sign_ins` | `api_usage` rows for `POST /v1/auth/google` |
| `apple/membership_month` | fixed 1 |

### What the numbers cannot see

Reported as `caveats` on `/admin/costs/overview` and `/admin/costs/usage`:

- **Ably `pose` messages.** Devices publish pose straight to Ably at 10 Hz with their own token; those
  messages never reach this API. The measured message count is therefore a floor — Ably's own dashboard is
  the source of truth. The projection *does* model them.
- **Vercel edge requests for the dashboard.** Only API calls appear in `api_usage`; the dashboard's static
  assets are billed to the same Vercel account but are invisible here.
- **GCS operations are counted as signed URLs minted.** An unused URL overcounts; a retried upload
  undercounts.
- **Active CPU and provisioned memory are ratios of measured wall time**, not Vercel's own meters.
- **Neon compute is an upper bound**: every request is assumed to keep the compute awake for the full
  five-minute autosuspend window, which bursts of traffic share in reality.

### `usage_events`

`api_usage` records one row per HTTP request; it cannot see a signed URL being minted or a message being
published. Migration `0003_usage_events.sql` adds a second table for exactly those:

```
usage_events(id bigserial, ts timestamptz default now(), kind text, count int, bytes bigint)
```

`recordUsageEvent(kind, count, bytes)` accumulates into an `AsyncLocalStorage` batch opened by the
`usageEventRecorder` middleware and writes one row per kind after the response, through
`waitUntil`. It never throws and never blocks a response — a cost counter must not be the reason an
upload fails. Kinds: `signed_upload`, `signed_download`, `keyframe_registered`, `ably_publish`,
`ably_token`, `bq_query`, `nr_push`, `gcs_list`.

## The projection

`GET /admin/costs/projection` describes a month of activity and prices it. Parameters (all optional,
defaults in brackets): `mappers` [2], `sessions_per_day` [2], `minutes_per_session` [10],
`keyframes_per_second` [3], `depth_bytes_per_keyframe` [55000], `jpeg_every_n` [0],
`viewers_per_session` [1], `map_size_mb` [40], `maps_per_day` [2], `retention_days` [30],
`dashboard_views_per_day` [20].

The response repeats the assumptions the arithmetic rests on (`assumptions[]`) and the quantities it
produced (`quantities[]`). The constants behind them are in `PROJECTION_CONSTANTS`: 10 keyframes per API
call and per Ably message, 10 Hz pose publishing, 2 000 inline points per keyframe at 48 B each, 25 ms of
Active CPU and 120 ms of wall time per invocation, a 120 s merge job per session, and so on.

**The finding worth knowing:** a keyframe row in Postgres costs about 96 KB because `points_inline`
carries 2 000 points as jsonb. Two mappers capturing at 1 Hz for ten minutes a day fill Neon's 0.5 GB free
plan several times over, while GCS, Ably and Vercel stay comfortably inside their free tiers. Dropping
`points_inline` once a party ends removes almost all of it.

## Free tiers and list prices

Checked **2026-09-04** against each provider's own page. `verified: false` marks a figure that could not
be read from that page (Google renders several pricing tables client-side, and Vercel's Hobby allowances
are injected by JavaScript); those came from a secondary summary of the same page and carry a `note`
saying so. Re-check them before quoting them anywhere that matters. `GET /admin/costs/pricing` returns the
table with `unverified_metrics` listing exactly which ones.

| Provider | Metric | Free per month | Beyond it | Verified | Source |
|---|---|---|---|---|---|
| Google Cloud Storage | Standard storage (us-east1) | 5 GB-months (US regions only) | $0.020 / GB-month | yes | [pricing examples](https://cloud.google.com/storage/pricing-examples), [Always Free](https://cloud.google.com/free/docs/free-cloud-features) |
| | Class A operations | 5,000 | $0.005 / 1,000 | yes | as above |
| | Class B operations | 50,000 | $0.0004 / 1,000 | yes | as above |
| | Data transfer out (North America) | 100 GB | $0.12 / GB (0–1 TB tier) | yes | as above |
| BigQuery | On-demand analysis | 1 TiB | $6.25 / TiB | quota only | [BigQuery pricing](https://cloud.google.com/bigquery/pricing) |
| | Active logical storage | 10 GiB | $0.02 / GiB-month | quota only | as above |
| Cloud Run Jobs | vCPU time | 180,000 vCPU-s | $0.000024 / vCPU-s | quota only | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| | Memory time | 360,000 GiB-s | $0.0000025 / GiB-s | quota only | as above |
| | Requests | 2,000,000 | $0.40 / million | quota only | as above |
| Google Sign-In | Sign in with Google | — | no published price | no | [Identity Services](https://developers.google.com/identity/gsi/web/guides/overview) |
| Vercel | Fast Data Transfer | 100 GB (Hobby) | $0.15 / GB (Pro, iad1) | price only | [regional pricing](https://vercel.com/docs/pricing/regional-pricing/iad1) |
| | Function invocations | 1,000,000 (Hobby) | $0.60 / million (Pro) | yes | [fluid pricing](https://vercel.com/docs/functions/usage-and-pricing) |
| | Active CPU | 4 CPU-hours (Hobby) | $0.128 / hour (Pro, iad1) | yes | as above |
| | Provisioned memory | 360 GB-hours (Hobby) | $0.0106 / GB-hour (Pro, iad1) | yes | as above |
| | Edge requests | 1,000,000 (Hobby) | $2.00 / million (Pro, iad1) | price only | [regional pricing](https://vercel.com/docs/pricing/regional-pricing/iad1) |
| Neon | Storage | 0.5 GB / project | $0.35 / GB-month (Launch) | yes | [Neon plans](https://neon.com/docs/introduction/plans) |
| | Compute | 100 CU-hours / project | $0.106 / CU-hour (Launch) | yes | as above |
| | Data transfer | 5 GB / project | $0.10 / GB (Launch) | yes | as above |
| Ably | Messages | 6,000,000 | $2.50 / million | yes | [Ably pricing](https://ably.com/pricing) |
| | Peak connections | 200 | Standard package, $29/month | yes | as above |
| | Peak channels | 200 | Standard package, $29/month | yes | as above |
| New Relic | Data ingest | 100 GB | $0.40 / GB (Original data option) | yes | [New Relic pricing](https://newrelic.com/pricing) |
| | Full platform users | 1 | $99 / user / month (Standard) | yes | as above |
| Apple | Developer Program | — | $99 / year, i.e. $8.25 / month | yes | [Program enrollment](https://developer.apple.com/programs/enroll/) |

Hobby is a **cap, not a bill**: exceeding a Vercel Hobby allowance pauses the resource for the rest of the
30-day period rather than charging for it, and the Hobby plan is for non-commercial use. The Pro prices
above are what the same usage would cost after upgrading, which is what the report prices.

Everything here is a US list price in USD, excluding tax and any committed-use or promotional discount.

## New Relic

`GET|POST /admin/newrelic/push` (run daily by Vercel Cron) also sends:

- `ghostmap.cost.estimated_monthly_usd` — gauge, attribute `provider` (one per provider plus `all`).
- `ghostmap.free_tier.used_pct` — gauge, attributes `provider` and `metric`.
- `ghostmap.free_tier.days_until_paid` — gauge, attribute `metric` (the first free tier to go).

## Keeping the table honest

Prices move. When they do: edit `src/lib/costs/pricing.ts`, set the entry's `as_of` to the day you checked
it, point `source` at the page you read, and flip `verified` to match whether you read the number on that
page or somewhere else. `GET /admin/costs/pricing` and the table above should then agree.
