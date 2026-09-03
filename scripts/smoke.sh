#!/usr/bin/env bash
# Smoke test against a running deployment: scripts/smoke.sh https://your-app.vercel.app
set -euo pipefail
BASE="${1:-http://localhost:3000}"
: "${ADMIN_API_KEY:?set ADMIN_API_KEY}"
: "${CLIENT_ACCESS_KEY:?set CLIENT_ACCESS_KEY (one of CLIENT_ACCESS_KEYS)}"
DEVICE_ID="${DEVICE_ID:-$(uuidgen | tr 'A-Z' 'a-z')}"
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }

echo "health:        $(curl -fsS "$BASE/health" | j "['ok']")"
TOKEN=$(curl -fsS -X POST "$BASE/v1/auth/token" -H 'Content-Type: application/json' \
  -d "{\"access_key\":\"$CLIENT_ACCESS_KEY\",\"device\":{\"id\":\"$DEVICE_ID\",\"name\":\"smoke\",\"platform\":\"ios\"}}" | j "['token']")
echo "device token:  ${TOKEN:0:16}…"
MAP=$(curl -fsS -X POST "$BASE/v1/maps" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"smoke map"}')
MAP_ID=$(echo "$MAP" | j "['map']['id']")
echo "map created:   $MAP_ID ($(echo "$MAP" | j "len(d['uploads'])") upload urls)"
SESSION=$(curl -fsS -X POST "$BASE/v1/sessions" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"smoke session"}')
SESSION_ID=$(echo "$SESSION" | j "['session']['id']")
echo "session:       $SESSION_ID"
curl -fsS -X POST "$BASE/v1/sessions/$SESSION_ID/keyframes" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"keyframes":[{"seq":1,"t":0.5,"pose":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"intrinsics":{"fx":213,"fy":213,"cx":128,"cy":96,"w":256,"h":192}}]}' >/dev/null && echo "keyframe:      registered"
echo "admin network: $(curl -fsS "$BASE/admin/network?hours=1" -H "Authorization: Bearer $ADMIN_API_KEY" | j "['totals']['requests']") requests in the last hour"
curl -fsS -X DELETE "$BASE/v1/maps/$MAP_ID" -H "Authorization: Bearer $TOKEN" >/dev/null && echo "map deleted"
echo "OK"
