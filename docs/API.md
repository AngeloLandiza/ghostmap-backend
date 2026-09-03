# API reference

Base URL: your Vercel deployment (e.g. `https://ghostmap-backend.vercel.app`). All bodies and responses are JSON. Errors are `{ "error": { "code", "message", "details?" } }` with codes `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `not_configured` 501, `upstream_error` 502, `internal` 500.

## Authentication

`Authorization: Bearer <token-or-key>` (or `X-Api-Key`). Four roles:

| Role | How obtained | Can |
|---|---|---|
| `device` | `POST /v1/auth/token` with a client access key **and** a `device` object → 30-day JWT | create/upload/finalize/delete its own maps, create/join sessions, stream keyframes, realtime publish |
| `client` | `POST /v1/auth/token` with a client access key, no device → 7-day JWT | read maps, sessions, keyframes, realtime subscribe |
| `worker` | `WORKER_API_KEY` directly, or exchanged for a 1-day JWT | claim/complete merge jobs |
| `admin` | `ADMIN_API_KEY` directly, or exchanged for a 1-day JWT | everything, plus `/admin/*` |

Vercel Cron calls `/admin/newrelic/push` with `Authorization: Bearer <CRON_SECRET>`.

### `POST /v1/auth/token`
```json
{ "access_key": "…", "device": { "id": "<uuid>", "name": "Angelo's iPhone", "platform": "ios" } }
```
→ `{ "token", "expires_at", "role", "device_id?" }`

### `GET /health` (public) → `{ ok, version, region, time }`
### `GET /v1/devices/me` (device) → `{ device, role }`

## Maps

A map is a finished on-device capture (the Ghostmap app's map folder). Files: `manifest.json`, `keyframes.bin`, `cloud.ply`, `thumbnail.png`, `worldmap.arworldmap`, `session.log`. The flow is *create → upload directly to GCS with the returned signed URLs → finalize*.

| Method & path | Role | Body / query | Returns |
|---|---|---|---|
| `GET /v1/maps` | device, client | `limit`, `cursor` (ISO date), `status`, `session_id` | `{ maps[], next_cursor }` |
| `POST /v1/maps` | device | `{ name, frame?, origin?, session_id?, parent_map_id?, files? }` | `201 { map, uploads[] }` |
| `POST /v1/maps/:id/upload-urls` | device (owner) | `{ files: [...] }` | `{ uploads[] }` |
| `POST /v1/maps/:id/finalize` | device (owner) | `{ manifest? }` (read from GCS if omitted) | `{ map }` with status `saved` |
| `GET /v1/maps/:id` | device, client | | `{ map, downloads: { "cloud.ply": { url, expires_at }, … } }` |
| `GET /v1/maps/:id/files/:name` | device, client | | `302` to a 5-minute signed URL |
| `PATCH /v1/maps/:id` | device (owner) | `{ name }` | `{ map }` |
| `DELETE /v1/maps/:id` | device (owner) | | `{ deleted, objects_removed }` |

An `uploads[]` entry: `{ path, url, method: "PUT"|"POST", headers, expires_at, resumable }`. For `PUT`, send the file body with the listed headers. For resumable (`cloud.ply`, `keyframes.bin`): `POST` with the listed headers and an empty body, read the `Location` header from GCS, then `PUT` the bytes to that location (optionally in chunks with `Content-Range`).

Map record fields: `id, name, version, parent_map_id, session_id, device_id, frame, origin, status (uploading|saved|failed|deleted), manifest, point_count, keyframe_count, bbox, duration_s, size_bytes, files[], created_at, finalized_at`.

## Sessions (collaborative mapping)

| Method & path | Role | Body / query | Returns |
|---|---|---|---|
| `POST /v1/sessions` | device | `{ name, origin?: {type: "session-start"\|"marker", marker_id?}, base_map_id? }` | `201 { session, participants, channel }` (creator = leader) |
| `GET /v1/sessions` | device, client | `status`, `limit` | `{ sessions[] }` |
| `GET /v1/sessions/:id` | device, client | | `{ session, participants, channel }` |
| `POST /v1/sessions/:id/join` | device | | `{ session, participants, channel }` |
| `POST /v1/sessions/:id/leave` | device | | `{ left }` |
| `POST /v1/sessions/:id/end` | leader / admin | | `{ session }` (status `ended`) |
| `POST /v1/sessions/:id/upload-urls` | participant | `{ items: [{ seq, kinds: ["depth","confidence","jpeg","mesh"] }] }` (≤ 100) | `{ uploads: [{ seq, kind, path, url, method, headers, expires_at }] }` |
| `POST /v1/sessions/:id/keyframes` | participant | `{ keyframes: [Keyframe] }` (≤ 50) | `201 { registered: [{ id, seq }] }` and an Ably `keyframes` message |
| `GET /v1/sessions/:id/keyframes` | device, client | `device_id`, `since_id`, `limit`, `urls=1` | `{ keyframes[], next_since_id }` |
| `POST /v1/sessions/:id/merge` | leader / admin | | `202 { job }` |

`Keyframe`: `{ seq, t, pose: [16 floats, column-major], intrinsics: {fx,fy,cx,cy,w,h}, tracking_state?, world_mapping_status?, depth_ref?, confidence_ref?, jpeg_ref?, mesh_ref?, points_inline?: [x,y,z,r,g,b,…] ≤ 2000 points, bytes? }`. Object paths default to `sessions/<session>/kf/<device>/<seq>.depth.lzfse` etc. Poses are expressed in the session's origin frame (marker frame when `origin.type == "marker"`).

Realtime channel `session:<id>` messages: `keyframes` `{ device_id, keyframes[] }`, `participant` `{ event: joined|left, device_id }`, `session` `{ event: ended }`, `merge` `{ event: succeeded|failed, job_id, map_id, error }`.

### `POST /v1/realtime/token` (device, client)
`{ session_id? }` → `{ token_request, channel, can_publish }`. Pass `token_request` to the Ably SDK (`authCallback`). Participants of the session can publish; others subscribe only.

### Markers
`GET /v1/markers` (device, client) → `{ markers[] }` · `POST /v1/markers` (admin) `{ id, family?, size_m?, description? }`.

### Merge jobs
| Method & path | Role | Notes |
|---|---|---|
| `GET /v1/merge-jobs` | device, client, worker | `status`, `session_id` |
| `GET /v1/merge-jobs/:id` | device, client, worker | |
| `POST /v1/merge-jobs/next` | worker | claims the oldest queued job (`{ job }` or `{ job: null }`) |
| `POST /v1/merge-jobs/:id/claim` | worker | |
| `POST /v1/merge-jobs/:id/complete` | worker | `{ output_map_id? , error? }` → session becomes `merged` or `failed` |

Job fields: `id, session_id, status (queued|running|succeeded|failed), requested_by, input_map_ids[], output_map_id, error, cloud_run_execution, worker, created_at, started_at, finished_at`.

## Admin (`ADMIN_API_KEY` or admin JWT)

| Method & path | Query | Returns |
|---|---|---|
| `POST /admin/db/migrate` | | creates/updates the schema from the bundled SQL (idempotent) |
| `GET /admin/overview` | | counts of devices, maps, map bytes, sessions, keyframes, pending merges |
| `GET /admin/network` | `hours` (default 24) | totals (requests, 4xx/5xx, p50/p95/p99/avg ms, bytes in/out), by route, by region, by country, per hour |
| `GET /admin/storage` | | bucket bytes/objects total and per prefix (cached 10 min) |
| `GET /admin/costs` | `days` (default 30) | BigQuery billing export: per day and service, totals (cached 1 h); 501 if not configured |
| `GET /admin/pricing` | `service=storage\|run\|bigquery`, `region` | Cloud Billing Catalog SKUs with tiered USD prices (cached 24 h) |
| `GET /admin/sessions`, `GET /admin/usage/recent`, `GET /v1/devices` | | inventories |
| `GET /admin/health` | | deep checks: database, GCP credentials, Ably, New Relic |
| `GET|POST /admin/newrelic/push` | | pushes metrics + a `GhostmapSnapshot` event to New Relic; run daily by Vercel Cron |

Metrics sent (all prefixed `ghostmap.`): `api.requests`, `api.errors.server`, `api.errors.client`, `api.latency.p50_ms|p95_ms|p99_ms`, `api.bytes.in|out`, `api.route.requests|p95_ms` (attributes `method`, `route`), `api.region.requests`, `api.country.requests`, `inventory.*`, `gcs.bytes`, `gcs.objects`, `gcs.prefix.bytes`, `gcs.estimated_monthly_usd`, `gcp.cost.30d_usd`, `gcp.cost.service_30d_usd` (attribute `gcp_service`), `gcp.cost.latest_day_usd`.
