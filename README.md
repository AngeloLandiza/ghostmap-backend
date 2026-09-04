# ghostmap-backend

The API behind [Ghostmap](https://github.com/AngeloLandiza/apple-VSLAM-client): room maps captured on iPhones are stored in Google Cloud Storage as they are recorded, several phones can map one room together over Ably realtime, and web / iOS clients read everything through one set of endpoints. Admin-only endpoints expose GCP spend, list prices, bucket usage and network statistics and push them to New Relic. No UI, JSON only, runs on Vercel.

```
iPhone (Ghostmap)  ──signed PUT──▶  Google Cloud Storage  ◀──signed GET──  Web / iOS viewers
      │  register keyframes / maps           ▲                                    ▲
      ▼                                      │ merge worker (Cloud Run Job)       │
  ghostmap-backend (Hono on Vercel) ── Neon Postgres ── Ably realtime (session:<id> channels)
      │
      └── /admin/* ── Cloud Billing, BigQuery billing export, bucket stats, api_usage ──▶ New Relic
```

## Features

| Feature | Endpoints | Setup guide |
|---|---|---|
| Auth: access keys → JWTs for devices, web clients, admins, workers | `POST /v1/auth/token`, `GET /v1/devices/me` | [01-vercel-and-auth](docs/setup/01-vercel-and-auth.md), [02-neon](docs/setup/02-neon-postgres.md) |
| Google accounts: sign in on iOS and the web, map/party ownership and visibility | `POST /v1/auth/google`, `GET /v1/auth/me` | [01-vercel-and-auth](docs/setup/01-vercel-and-auth.md) |
| Parties: invite codes, share links, up to four accounts per party, colours, join/leave/rejoin | `POST /v1/sessions/join`, `GET /v1/sessions/by-code/:code` | [04-ably-realtime](docs/setup/04-ably-realtime.md) |
| Map storage in GCS in real time (signed uploads, finalize, download, delete) | `/v1/maps…` | [03-google-cloud-storage](docs/setup/03-google-cloud-storage.md) |
| Collaborative sessions: participants, keyframe streaming, realtime fan-out, merge jobs | `/v1/sessions…`, `/v1/realtime/token`, `/v1/merge-jobs…`, `/v1/markers` | [04-ably-realtime](docs/setup/04-ably-realtime.md), [05-merge-worker](docs/setup/05-merge-worker.md) |
| Client endpoints for the website and the iOS app | all `/v1/*` | [06-clients](docs/setup/06-clients.md) |
| Admin monitoring: GCP costs and pricing, storage, network stats, New Relic push | `/admin/*` | [07-admin-monitoring-newrelic](docs/setup/07-admin-monitoring-newrelic.md) |
| Cost estimation: every provider's free tier, what is left of it and what a month would cost | `/admin/costs/*` | [docs/COSTS.md](docs/COSTS.md) |

Full endpoint reference: [docs/API.md](docs/API.md). Where every cost number comes from: [docs/COSTS.md](docs/COSTS.md).

## Quick start (local)

```bash
npm install
cp .env.example .env            # fill in at least AUTH_JWT_SECRET, ADMIN_API_KEY, CLIENT_ACCESS_KEYS, DATABASE_URL
npm run db:migrate              # creates the tables in Neon (or POST /admin/db/migrate on a deployment)
npm run dev                     # http://localhost:3000
npm test                        # unit tests (no database needed)
ADMIN_API_KEY=… CLIENT_ACCESS_KEY=… scripts/smoke.sh http://localhost:3000
E2E_BASE_URL=… E2E_ADMIN_API_KEY=… E2E_CLIENT_ACCESS_KEY=… npm run test:e2e   # against a real deployment; see docs/TESTING.md
```

Deploy: push to GitHub and import the repo in Vercel (framework preset "Other"); set the environment variables from `.env.example`; every push to `main` deploys. Details in the setup guides. `.github/workflows/ci.yml` runs the unit tests on every push/PR and the E2E suite whenever `E2E_BASE_URL`, `E2E_ADMIN_API_KEY` and `E2E_CLIENT_ACCESS_KEY` are set as repository secrets — see [docs/TESTING.md](docs/TESTING.md).

## Stack

Hono 4 (TypeScript) on Vercel's Node runtime · Neon Postgres via Drizzle (HTTP driver) · `@google-cloud/storage` V4 signed URLs · Ably token auth and REST publish · Cloud Billing Catalog API, BigQuery billing export, Cloud Run Jobs API · New Relic Metric and Event APIs · zod validation · vitest.

## Layout

```
api/index.ts          Vercel entry (all paths rewrite here)
src/app.ts            middleware (CORS, security headers, auth, usage recording) + routes
src/routes/           auth, devices, maps, sessions, realtime, markers, merge, admin, health
src/lib/              auth (JWT), google (id tokens), access (ownership), parties (invite codes, cap,
                      colours), gcs, ably, gcp (billing, pricing, cloud run), newrelic, usage,
                      usageEvents (cost counters), costs/ (pricing, usage, engine, projection), cache,
                      errors, validate (zValidator wrapped so failed validation uses the same error envelope)
src/db/               drizzle schema, Neon client, SQL migrations
src/schemas.ts        request validation
scripts/              migrate.ts, sync-migrations.ts, smoke.sh, vercel-env.sh, vercel-env-apply.sh
test/                 unit tests (vitest.config.ts) — no database, run by `npm test`
test/e2e/             E2E suite (vitest.e2e.config.ts) against a live deployment — run by `npm run test:e2e`
docs/                 API.md, TESTING.md and setup guides
```
