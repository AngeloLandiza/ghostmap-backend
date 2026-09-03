#!/usr/bin/env bash
# One-shot: generate the app's secrets and add them to the linked Vercel project (Production + Preview).
# Run once from the repo root after `vercel login` and `vercel link`. Re-running overwrites the values.
set -euo pipefail
command -v vercel >/dev/null || { echo "install the CLI first: npm i -g vercel"; exit 1; }
gen() { openssl rand -hex "$1"; }
declare -A VARS=(
  [AUTH_JWT_SECRET]="$(gen 32)"
  [ADMIN_API_KEY]="gm_admin_$(gen 20)"
  [CLIENT_ACCESS_KEYS]="gm_client_$(gen 20)"
  [WORKER_API_KEY]="gm_worker_$(gen 20)"
  [CRON_SECRET]="$(gen 24)"
  [ALLOWED_ORIGINS]="${ALLOWED_ORIGINS:-http://localhost:5173}"
  [APP_VERSION]="0.1.0"
)
for name in "${!VARS[@]}"; do
  for target in production preview; do
    vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
    printf '%s' "${VARS[$name]}" | vercel env add "$name" "$target" >/dev/null
  done
  echo "set $name"
done
mkdir -p .secrets && chmod 700 .secrets
{
  echo "# generated $(date -u +%FT%TZ) — keep private; the same values are now in Vercel"
  for name in "${!VARS[@]}"; do echo "$name=${VARS[$name]}"; done
} > .secrets/ghostmap-backend.env
chmod 600 .secrets/ghostmap-backend.env
echo "Saved a copy to .secrets/ghostmap-backend.env (git-ignored). Redeploy with: vercel --prod"
