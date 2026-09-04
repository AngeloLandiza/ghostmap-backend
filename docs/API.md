# API reference

Base URL: your Vercel deployment (e.g. `https://ghostmap-backend.vercel.app`). All bodies and responses are JSON. Errors are `{ "error": { "code", "message", "details?" } }` with codes `bad_request` 400 (includes every failed body/query validation — `details` carries the zod issues), `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `session_full` 409, `session_ended` 410, `not_configured` 501, `upstream_error` 502, `internal` 500, plus the framework's own `http_error` 400 for a request the JSON parser itself rejects (e.g. malformed JSON body, before validation ever runs).

## Authentication

`Authorization: Bearer <token-or-key>` (or `X-Api-Key`). Five roles:

| Role | How obtained | Can |
|---|---|---|
| `device` | `POST /v1/auth/token` with a client access key **and** a `device` object, or `POST /v1/auth/google` with a `device` object → 30-day JWT | create/upload/finalize/delete its own maps, create/join parties, stream keyframes, realtime publish |
| `user` | `POST /v1/auth/google` without a device → 7-day JWT | read and manage its own maps, create/join/leave/end parties as a viewer, realtime publish in parties it joined |
| `client` | `POST /v1/auth/token` with a client access key, no device → 7-day JWT | legacy read-only operator key: read all maps, sessions and keyframes, realtime subscribe |
| `worker` | `WORKER_API_KEY` directly, or exchanged for a 1-day JWT | claim/complete merge jobs |
| `admin` | `ADMIN_API_KEY` directly, or exchanged for a 1-day JWT | everything, plus `/admin/*` |

Vercel Cron calls `/admin/newrelic/push` with `Authorization: Bearer <CRON_SECRET>`.

### `POST /v1/auth/token`
```json
{ "access_key": "…", "device": { "id": "<uuid>", "name": "Angelo's iPhone", "platform": "ios" } }
```
→ `{ "token", "expires_at", "role", "device_id?" }`

### `POST /v1/auth/google`
```json
{ "id_token": "<google id token>", "device": { "id": "<uuid>", "name": "Angelo's iPhone", "platform": "ios" } }
```
The id token is verified with `google-auth-library` against the audiences in `GOOGLE_CLIENT_IDS`; accounts whose email Google has not verified are rejected (401). The account is upserted on `google_sub`.

* with `device` → `{ token, expires_at, role: "device", device_id, user }` (30-day JWT carrying both `user_id` and `device_id`; the device row is bound to the account)
* without → `{ token, expires_at, role: "user", user }` (7-day JWT carrying `user_id`)

`user`: `{ id, email, name, picture_url, created_at }`. Returns `501 not_configured` when `GOOGLE_CLIENT_IDS` is empty.

### `GET /v1/auth/me` (any authenticated role) → `{ role, device_id, user }` (`user` is `null` for key-based and legacy tokens).

### `GET /health` (public) → `{ ok, version, region, time }`
### `GET /v1/devices/me` (device) → `{ device, role }`

## Ownership and visibility

Maps carry `owner_user_id` (the signed-in account) and `device_id`; parties carry `owner_user_id` and `leader_device_id`.

* **Read** — a `device`/`user` sees its own maps, maps produced by a party it takes (or took) part in, and rows created before accounts existed (no owner at all). Parties are visible to their owner, their leader device and their participants. `admin` and the legacy read-only `client` key see everything.
* **Write** — renaming, finalizing, re-uploading and deleting a map require ownership. Ending or merging a party requires its owner account, its leader device or `admin`. The `client` key never writes.

## Maps

A map is a finished on-device capture (the Ghostmap app's map folder). Files: `manifest.json`, `keyframes.bin`, `cloud.ply`, `thumbnail.png`, `worldmap.arworldmap`, `session.log`. The flow is *create → upload directly to GCS with the returned signed URLs → finalize*.

| Method & path | Role | Body / query | Returns |
|---|---|---|---|
| `GET /v1/maps` | device, client, user | `limit`, `cursor` (ISO date), `status`, `session_id` | `{ maps[], next_cursor }` (filtered by visibility) |
| `POST /v1/maps` | device, user | `{ name, frame?, origin?, session_id?, parent_map_id?, files? }` | `201 { map, uploads[] }` |
| `POST /v1/maps/:id/upload-urls` | owner | `{ files: [...] }` | `{ uploads[] }` |
| `POST /v1/maps/:id/finalize` | owner | `{ manifest? }` (read from GCS if omitted) | `{ map }` with status `saved` |
| `GET /v1/maps/:id` | device, client, user | | `{ map, downloads: { "cloud.ply": { url, expires_at }, … } }` |
| `GET /v1/maps/:id/files/:name` | device, client, user | | `302` to a 5-minute signed URL |
| `PATCH /v1/maps/:id` | owner | `{ name }` | `{ map }` |
| `DELETE /v1/maps/:id` | owner | | `{ deleted, objects_removed }` |

An `uploads[]` entry: `{ path, url, method: "PUT"|"POST", headers, expires_at, resumable }`. For `PUT`, send the file body with the listed headers. For resumable (`cloud.ply`, `keyframes.bin`): `POST` with the listed headers and an empty body, read the `Location` header from GCS, then `PUT` the bytes to that location (optionally in chunks with `Content-Range`).

Map record fields (the row as stored — camelCase, not the snake_case of request bodies): `id, name, version, parentMapId, sessionId, deviceId, ownerUserId, frame, origin, status (uploading|saved|failed|deleted), manifest, pointCount, keyframeCount, bbox, durationS, sizeBytes, files[], createdAt, finalizedAt`.

## Parties (collaborative sessions)

A party is a session several phones and browsers share. It has an **invite code** (8 uppercase base32 characters, `A-Z` and `2-7`) and a **share link** `${DASHBOARD_URL}/join/<code>`.

| Method & path | Role | Body / query | Returns |
|---|---|---|---|
| `POST /v1/sessions` | device, user | `{ name, origin?: {type: "session-start"\|"marker", marker_id?}, base_map_id?, max_participants? }` | `201 { session, participants, channel, share_url }` |
| `GET /v1/sessions` | device, client, user | `status`, `limit` | `{ sessions[] }` (filtered by visibility; each row also carries `participant_count` and `owner_name`) |
| `GET /v1/sessions/by-code/:code` | any authenticated | | `{ session: { id, name, status, origin, invite_code, share_url, participant_count, max_participants, owner_name }, can_join, reason }` |
| `POST /v1/sessions/join` | device, user | `{ code, kind?: "device"\|"viewer", display_name? }` | `{ session, participants, channel, share_url, me, realtime }` |
| `GET /v1/sessions/:id` | device, client, user | | `{ session, participants, channel, share_url }` |
| `POST /v1/sessions/:id/join` | device, user | `{ kind?, display_name? }` (optional body) | same as `POST /v1/sessions/join` |
| `POST /v1/sessions/:id/leave` | device, user | | `{ left, participants }` |
| `POST /v1/sessions/:id/end` | owner / leader / admin | | `{ session }` (status `ended`) |
| `POST /v1/sessions/:id/upload-urls` | participant device | `{ items: [{ seq, kinds: ["depth","confidence","jpeg","mesh"] }] }` (≤ 100) | `{ uploads: [{ seq, kind, path, url, method, headers, expires_at }] }` |
| `POST /v1/sessions/:id/keyframes` | participant device | `{ keyframes: [Keyframe] }` (≤ 50) | `201 { registered: [{ id, seq }] }` and an Ably `keyframes` message |
| `GET /v1/sessions/:id/keyframes` | device, client, user (readable party) | `device_id`, `since_id`, `limit`, `urls=1` | `{ keyframes[], next_since_id }` |
| `POST /v1/sessions/:id/merge` | owner / leader / admin | | `202 { job }` |

**Joining.** `kind` defaults to `device` for device tokens and `viewer` for user tokens; joining as a mapper needs a device token, joining as a viewer needs a signed-in account. `max_participants` (default 4, max 8) caps the **distinct active accounts** in a party — one account counts once however many phones it brings, and a legacy device with no account counts on its own. Joining a full party → `409 { "error": { "code": "session_full" } }`; joining an ended (or merging/merged) party → `410 { "error": { "code": "session_ended" } }`. Rejoining is always allowed: it clears `left_at` and keeps the colour the participant was given.

`participant`: `{ id, session_id, device_id, user_id, kind: "device"|"viewer", color, display_name, role: "leader"|"member", joined_at, left_at }`. Colours come from a fixed palette of eight, handed out in join order.

`me` is the caller's own participant row. `realtime` is `{ token_request, channel, can_publish }` when Ably is configured, otherwise `null`.

`Keyframe`: `{ seq, t, pose: [16 floats, column-major], intrinsics: {fx,fy,cx,cy,w,h}, tracking_state?, world_mapping_status?, aligned?, depth_ref?, confidence_ref?, jpeg_ref?, mesh_ref?, points_inline?: [x,y,z,r,g,b,…] ≤ 2000 points, bytes? }`. Object paths default to `sessions/<session>/kf/<device>/<seq>.depth.lzfse` etc. Poses are expressed in the party's origin frame (marker frame when `origin.type == "marker"`); `aligned` (default `true`) is `false` while a device has not seen the marker yet, so viewers can grey those points out.

Realtime channel `session:<id>` messages: `keyframes` `{ device_id, user_id, color, keyframes: [{ seq, t, pose, intrinsics, tracking_state, aligned, depth_ref, points_inline }] }`, `participant` `{ event: joined|left, participant }`, `session` `{ event: ended }`, `merge` `{ event: succeeded|failed, job_id, map_id, error }`. Devices also publish `pose` `{ device_id, t, pose, aligned }` at ≤ 10 Hz, and every client enters presence with `{ user_id, display_name, kind, color }`.

### `POST /v1/realtime/token` (device, client, user)
`{ session_id? }` → `{ token_request, channel, can_publish }`. Pass `token_request` to the Ably SDK (`authCallback`). With a `session_id`, an **active participant** (mapper device or signed-in viewer) gets `publish, subscribe, presence, history` on that channel and anyone else gets `403 forbidden`; `admin` gets everything and the legacy `client` key keeps its subscribe-only token.

### Markers
`GET /v1/markers` (device, client, user) → `{ markers[] }` · `POST /v1/markers` (admin) `{ id, family?, size_m?, description? }`.

### Merge jobs
| Method & path | Role | Notes |
|---|---|---|
| `GET /v1/merge-jobs` | device, client, user, worker | `status`, `session_id` |
| `GET /v1/merge-jobs/:id` | device, client, user, worker | |
| `POST /v1/merge-jobs/next` | worker | claims the oldest queued job (`{ job }` or `{ job: null }`) |
| `POST /v1/merge-jobs/:id/claim` | worker | |
| `POST /v1/merge-jobs/:id/complete` | worker | `{ output_map_id? , error? }` → session becomes `merged` or `failed` |

Job fields (the row as stored — camelCase): `id, sessionId, status (queued|running|succeeded|failed), requestedBy, inputMapIds[], outputMapId, error, cloudRunExecution, worker, createdAt, startedAt, finishedAt`.

## Admin (`ADMIN_API_KEY` or admin JWT)

| Method & path | Query | Returns |
|---|---|---|
| `POST /admin/db/migrate` | | creates/updates the schema from the bundled SQL (idempotent) |
| `GET /admin/overview` | | counts of users, devices, maps, map bytes, sessions, keyframes, pending merges |
| `GET /admin/network` | `hours` (default 24) | totals (requests, 4xx/5xx, p50/p95/p99/avg ms, bytes in/out), by route, by region, by country, per hour |
| `GET /admin/storage` | | bucket bytes/objects total and per prefix (cached 10 min) |
| `GET /admin/costs` | `days` (default 30) | BigQuery billing export: **actual** spend per day and service, totals (cached 1 h); 501 if not configured |
| `GET /admin/costs/overview` | `days` (1-365, default 30) | measured usage priced against the table: per provider `{ items[], total_usd, free_tier }`, `grand_total_usd`, `monthly_run_rate_usd`, `free_tier`, `actual.gcp`, `measured`, `caveats[]` |
| `GET /admin/costs/usage` | `days` (1-365, default 30) | what the window actually contained (`api_usage`, `usage_events`, bucket stats, `pg_database_size`, inventory) and the monthly `quantities[]` it implies |
| `GET /admin/costs/pricing` | | the price table: `{ month_days, pricing[], unverified_metrics[] }` — each entry has `provider, metric, label, kind, unit, unit_price_usd, free_quota, as_of, source, verified, note?` |
| `GET /admin/costs/projection` | see below | the calculator: the same report shape plus `params`, `assumptions[]` and `quantities[]` |
| `GET /admin/pricing` | `service=storage\|run\|bigquery`, `region` | Cloud Billing Catalog SKUs with tiered USD prices (cached 24 h) |
| `GET /admin/sessions`, `GET /admin/usage/recent`, `GET /v1/devices` | | inventories |
| `GET /admin/health` | | deep checks: database, GCP credentials, Ably, New Relic |
| `GET|POST /admin/newrelic/push` | | pushes metrics + a `GhostmapSnapshot` event to New Relic; run daily by Vercel Cron |

Metrics sent (all prefixed `ghostmap.`): `api.requests`, `api.errors.server`, `api.errors.client`, `api.latency.p50_ms|p95_ms|p99_ms`, `api.bytes.in|out`, `api.route.requests|p95_ms` (attributes `method`, `route`), `api.region.requests`, `api.country.requests`, `inventory.*`, `gcs.bytes`, `gcs.objects`, `gcs.prefix.bytes`, `gcs.estimated_monthly_usd`, `gcp.cost.30d_usd`, `gcp.cost.service_30d_usd` (attribute `gcp_service`), `gcp.cost.latest_day_usd`, `cost.estimated_monthly_usd` (attribute `provider`, plus `provider=all`), `free_tier.used_pct` (attributes `provider`, `metric`), `free_tier.days_until_paid` (attribute `metric`).

### `GET /admin/costs/projection`

All parameters optional; anything omitted falls back to the default. `mappers` [2], `sessions_per_day` [2], `minutes_per_session` [10], `keyframes_per_second` [3], `depth_bytes_per_keyframe` [55000], `jpeg_every_n` [0, meaning no JPEGs], `viewers_per_session` [1], `map_size_mb` [40], `maps_per_day` [2], `retention_days` [30], `dashboard_views_per_day` [20].

### The cost report shape

```jsonc
{
  "window_days": 30,          // null for a projection
  "month_days": 30,
  "providers": [{
    "provider": "gcs", "provider_label": "Google Cloud Storage",
    "items": [{
      "metric": "class_a_ops", "label": "Class A operations (writes, lists)",
      "quantity": 62790,      // for one 30-day month
      "measured_quantity": 31395, "unit": "operation",
      "free_quota": 5000, "billable_quantity": 57790,
      "unit_price_usd": 0.000005, "cost_usd": 0.28895,
      "used_pct": 1255.8, "days_until_free_exhausted": 2.389,
      "source": "https://…", "as_of": "2026-09-04", "verified": true,
      "basis": "usage_events:signed_upload+gcs_list"
    }],
    "total_usd": 0.28895,
    "free_tier": { "used_pct_max": 1255.8, "first_exhausted_metric": "gcs/class_a_ops", "days_until_paid_at_current_rate": 2.389 }
  }],
  "grand_total_usd": 18.065437,
  "monthly_run_rate_usd": 18.065437,
  "free_tier": { … },         // the same summary across every provider
  "actual": { "gcp": { "total_usd": 0, "by_service": {}, "days": 30 } },
  "unverified_metrics": ["bigquery/query_tib", …]
}
```

`billable = max(0, quantity − free_quota)`. How every quantity is measured or estimated, and the free-tier limits with the dates they were checked, are in [docs/COSTS.md](COSTS.md).
