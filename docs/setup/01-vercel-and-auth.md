# 1. Vercel project and authentication

## What this feature gives you
The API skeleton on Vercel: `/health`, `POST /v1/auth/token`, CORS for your web origins, per-request usage recording, and the admin/client/device/worker roles every other feature relies on.

## Steps
1. **Generate secrets** (keep them in a password manager):
   ```bash
   openssl rand -hex 32   # AUTH_JWT_SECRET
   openssl rand -hex 24   # ADMIN_API_KEY
   openssl rand -hex 24   # CLIENT_ACCESS_KEYS (one per app; comma-separate several)
   openssl rand -hex 24   # WORKER_API_KEY
   openssl rand -hex 24   # CRON_SECRET
   ```
2. **Create the Vercel project**: vercel.com → Add New → Project → import `AngeloLandiza/ghostmap-backend`. Framework preset **Other**, root directory `/`, build command empty, output directory empty (the `api/` folder is detected automatically). Node.js version 20 or 22 (Settings → General).
3. **Environment variables** (Settings → Environment Variables, for Production and Preview): everything in `.env.example`. Start with `AUTH_JWT_SECRET`, `ADMIN_API_KEY`, `CLIENT_ACCESS_KEYS`, `WORKER_API_KEY`, `CRON_SECRET`, `ALLOWED_ORIGINS`, `DATABASE_URL` (guide 2). Add the GCP, Ably and New Relic variables as you complete guides 3–7.
4. **Deploy**: Vercel deploys on every push to `main`. Or from the CLI: `npm i -g vercel && vercel link && vercel --prod`.
5. **Cron**: `vercel.json` schedules `GET /admin/newrelic/push` once a day (`0 8 * * *`), because the Hobby plan allows only daily crons — any more frequent schedule (`0 * * * *`, `*/10 * * * *`) is rejected at deploy time. On Pro, change the schedule to `*/10 * * * *` for 10-minute snapshots. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` exists in the project's env.
6. **Verify**:
   ```bash
   curl https://<your-app>.vercel.app/health
   curl -X POST https://<your-app>.vercel.app/v1/auth/token -H 'Content-Type: application/json' \
     -d '{"access_key":"<CLIENT_ACCESS_KEY>","device":{"id":"<uuid>","name":"test","platform":"ios"}}'
   ```

## Notes
- Preview deployments (`*.vercel.app`) are always allowed by CORS; add your production web origin to `ALLOWED_ORIGINS`.
- Rotate a client key by adding the new one to `CLIENT_ACCESS_KEYS`, shipping it, then removing the old one. Existing JWTs stay valid until they expire (30 days for devices).
- Rate limiting: enable Vercel's Firewall / WAF rules on the project if the API is public.
