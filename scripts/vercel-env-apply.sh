#!/usr/bin/env bash
# Applies KEY=value lines from one or more env files to the linked Vercel project (Production + Preview),
# replacing existing values. Values never appear in the terminal. Usage:
#   vercel login && vercel link          # once
#   scripts/vercel-env-apply.sh .secrets/ghostmap-backend.gcp.env .secrets/ghostmap-backend.extra.env
set -euo pipefail
command -v vercel >/dev/null || { echo "install the CLI first: npm i -g vercel"; exit 1; }
[[ $# -gt 0 ]] || { echo "usage: $0 <env-file> [more env files]"; exit 1; }
for file in "$@"; do
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    name="${line%%=*}"; value="${line#*=}"
    for target in production preview; do
      vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
      printf '%s' "$value" | vercel env add "$name" "$target" >/dev/null
    done
    echo "set $name (${#value} chars)"
  done < "$file"
done
echo "done — redeploy to pick up the new values: vercel --prod  (or push a commit)"
