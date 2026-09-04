# Testing

Two suites, two purposes (PLAN §6). `npm test` proves the code is correct in isolation and needs
nothing but Node. `npm run test:e2e` proves a live deployment actually works end to end, and needs a
running deployment plus three keys for it.

| | `npm test` | `npm run test:e2e` |
|---|---|---|
| Config | `vitest.config.ts` | `vitest.e2e.config.ts` |
| Files | `test/*.test.ts` | `test/e2e/*.e2e.test.ts` |
| Talks to | nothing (imports `src/app.ts` in-process; `app.request()` never opens a socket) | a real deployment, over HTTPS |
| Needs | nothing | `E2E_BASE_URL`, `E2E_ADMIN_API_KEY`, `E2E_CLIENT_ACCESS_KEY` |
| Runs in CI | always, on every push and PR | only when those three secrets exist |

## Unit tests — `npm test`

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

No `DATABASE_URL`, no GCS, no Ably: `test/routes.test.ts` sets fake env vars and calls
`app.request(path, init)` directly, which runs the real Hono middleware stack (auth, CORS, error
handling) in the same process without a network hop. That is enough to prove:

- validation happens before any database call (a bad body is `400` even with `DATABASE_URL` pointing
  nowhere real),
- role checks are correct (`test/access.test.ts`, and the 401/403 cases in `test/routes.test.ts`),
- pure logic is right: invite codes, the participant cap and colour palette (`test/parties.test.ts`),
  JWT minting/verification (`test/auth.test.ts`), the cost pricing/engine/projection math
  (`test/costs.test.ts`), and schema edge cases (`test/schemas.test.ts`).

What it cannot prove: that Neon, GCS or Ably are reachable and configured correctly, that a signed
URL an unauthenticated client receives actually accepts an upload, or that two requests hitting two
different serverless instances agree about the database. That is what the E2E suite is for.

## End-to-end tests — `npm run test:e2e`

```bash
export E2E_BASE_URL=https://ghostmap-backend.vercel.app   # or a preview deployment
export E2E_ADMIN_API_KEY=...                               # that deployment's ADMIN_API_KEY
export E2E_CLIENT_ACCESS_KEY=...                            # one of its CLIENT_ACCESS_KEYS
npm run test:e2e
```

Every spec in `test/e2e/` opens with `describe.skipIf(!E2E_ENABLED)`, where `E2E_ENABLED` is true only
when all three variables above are set (`test/e2e/helpers.ts`). Leave any of them unset and the whole
suite reports as **skipped**, not failed — that is what lets `npm test` and CI's `unit` job ignore it
entirely, and it is why the suite is safe to leave wired into CI even for contributors who cannot
reach a deployment.

Point `E2E_BASE_URL` at whichever deployment you want proven: production, a Vercel preview, or
`http://localhost:3000` from `npm run dev` — as long as that instance has its own `DATABASE_URL`,
`GCS_BUCKET`/`GCP_SA_KEY_B64`, and (for the realtime assertion) `ABLY_API_KEY` configured, since the
suite never talks to Neon, GCS or Ably directly; it only calls the HTTP API, the same way a phone or
the dashboard would.

**Every synthetic device or party the suite creates is deleted or ended before the process exits**
(`test/e2e/helpers.ts`'s `registerCleanup`/`runCleanups`, run from each spec's `afterAll`), so running
this against production leaves nothing behind beyond a few `e2e-*`-named rows in `devices` and a
handful of `ended` sessions. It never deletes or mutates anything it did not itself create.

### What each file proves

| File | Proves |
|---|---|
| `health.e2e.test.ts` | The deployment is up and `/health` needs no auth. |
| `auth.e2e.test.ts` | `POST /v1/auth/token` mints a working, independent JWT for five distinct synthetic devices from one client access key, and `GET /v1/auth/me` reports the right device back for each. |
| `maps.e2e.test.ts` | The full map lifecycle against real GCS: `POST /v1/maps` → a signed URL that actually accepts a PUT (following the resumable-upload dance for `cloud.ply`) → `finalize` refuses to run early and succeeds once the blob exists → `GET` returns a working signed download URL → `DELETE` removes it, and that ownership is enforced (a second device gets `403`). |
| `parties.e2e.test.ts` | The one thing that cannot be unit-tested: real concurrent participants against a real database. Device A creates a party and is its leader; `GET /v1/sessions/by-code/:code` finds it; devices B, C, D join, bringing the party to exactly `max_participants` (4) **distinct devices** (no Google account is involved, so each device counts on its own, per PLAN §2); device E is refused with `409 session_full`; device D leaves and rejoins and keeps its original colour; keyframes registered with `points_inline` and `aligned: false` come back unchanged from `GET .../keyframes?since_id=`; an active participant's realtime token has `can_publish: true` (skipped with a warning, not a failure, if the deployment has no `ABLY_API_KEY`) while a non-participant is refused before Ably is even asked; ending the party turns a later join attempt into `410 session_ended`. |
| `admin.e2e.test.ts` | Every admin endpoint PLAN §6 names answers for a real admin key and refuses an unauthenticated request: `overview`, `network`, `storage`, `costs/overview`, `costs/projection`, `costs/pricing`, and that `POST /admin/db/migrate` is safe to run twice (idempotent `CREATE … IF NOT EXISTS` migrations, same `applied` list both times). |

### Writing a new E2E spec

Import `test/e2e/helpers.ts`, wrap the `describe` in `describe.skipIf(!E2E_ENABLED)`, mint whatever
tokens you need with `mintDeviceToken(label)` (each call is a fresh synthetic device — a real client
access key exchange, not a stub), and call `registerCleanup(fn)` for anything durable you create. Use
plain `fetch` semantics throughout (`get`/`post`/`patch`/`del` return `{ status, body, headers }` and
never throw on a non-2xx status) so assertions read the same way whether the API answered `200` or
`409`.

## CI

`.github/workflows/ci.yml` has three jobs:

1. **`unit`** — `npm run typecheck` and `npm test`. Runs on every push to `main` and every pull
   request; needs no secrets.
2. **`e2e-check`** — a tiny job that turns the three `E2E_*` **repository/organization secrets** into
   a job output. GitHub Actions does not expose the `secrets` context inside a job-level `if:`
   (only inside a step's `if:`/`env:`), so this is the standard workaround: a cheap first job computes
   `enabled: 'true' | 'false'` from `secrets.E2E_BASE_URL != ''` etc. in a step, and the next job reads
   `needs.e2e-check.outputs.enabled`.
3. **`e2e`** — `needs: e2e-check`, gated on `if: needs.e2e-check.outputs.enabled == 'true'`, runs
   `npm run test:e2e` with those three secrets as env vars. Add them once, in the repo's
   **Settings → Secrets and variables → Actions**, and this job turns on; leave them unset (e.g. in a
   fork) and it is skipped, not failed. Secrets are unavailable to workflow runs triggered by a pull
   request from a fork regardless, so this job never runs against untrusted PR code either.

Point them at whichever deployment CI should prove is healthy — most repos will use the production
URL and its real admin/client keys, since the suite cleans up after itself.
