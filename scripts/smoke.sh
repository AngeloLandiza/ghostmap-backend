#!/usr/bin/env bash
# Smoke test against a running deployment: scripts/smoke.sh https://your-app.vercel.app
# Optional: GOOGLE_ID_TOKEN=<google id token> also exercises POST /v1/auth/google and GET /v1/auth/me.
set -euo pipefail
BASE="${1:-http://localhost:3000}"
: "${ADMIN_API_KEY:?set ADMIN_API_KEY}"
: "${CLIENT_ACCESS_KEY:?set CLIENT_ACCESS_KEY (one of CLIENT_ACCESS_KEYS)}"
DEVICE_ID="${DEVICE_ID:-$(uuidgen | tr 'A-Z' 'a-z')}"
VIEWER_DEVICE_ID="${VIEWER_DEVICE_ID:-$(uuidgen | tr 'A-Z' 'a-z')}"
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }
token_for() { # token_for <device-id> <name>
  curl -fsS -X POST "$BASE/v1/auth/token" -H 'Content-Type: application/json' \
    -d "{\"access_key\":\"$CLIENT_ACCESS_KEY\",\"device\":{\"id\":\"$1\",\"name\":\"$2\",\"platform\":\"ios\"}}" | j "['token']"
}

echo "health:        $(curl -fsS "$BASE/health" | j "['ok']")"
TOKEN=$(token_for "$DEVICE_ID" "smoke")
echo "device token:  ${TOKEN:0:16}…"
echo "auth/me:       $(curl -fsS "$BASE/v1/auth/me" -H "Authorization: Bearer $TOKEN" | j "['role']")"

if [ -n "${GOOGLE_ID_TOKEN:-}" ]; then
  USER_TOKEN=$(curl -fsS -X POST "$BASE/v1/auth/google" -H 'Content-Type: application/json' \
    -d "{\"id_token\":\"$GOOGLE_ID_TOKEN\"}" | j "['token']")
  echo "google sign-in: $(curl -fsS "$BASE/v1/auth/me" -H "Authorization: Bearer $USER_TOKEN" | j "['user']['email']")"
fi

MAP=$(curl -fsS -X POST "$BASE/v1/maps" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"smoke map"}')
MAP_ID=$(echo "$MAP" | j "['map']['id']")
echo "map created:   $MAP_ID ($(echo "$MAP" | j "len(d['uploads'])") upload urls)"

# ---- party: create -> look up by code -> join as a viewer -> leave ----
SESSION=$(curl -fsS -X POST "$BASE/v1/sessions" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"smoke party","max_participants":4}')
SESSION_ID=$(echo "$SESSION" | j "['session']['id']")
CODE=$(echo "$SESSION" | j "['session']['inviteCode']")
echo "party:         $SESSION_ID code $CODE"
echo "share url:     $(echo "$SESSION" | j "['share_url']")"

BY_CODE=$(curl -fsS "$BASE/v1/sessions/by-code/$CODE" -H "Authorization: Bearer $TOKEN")
echo "by-code:       $(echo "$BY_CODE" | j "['session']['name']") — $(echo "$BY_CODE" | j "['session']['participant_count']")/$(echo "$BY_CODE" | j "['session']['max_participants']") participants, can_join=$(echo "$BY_CODE" | j "['can_join']")"

VIEWER_TOKEN=$(token_for "$VIEWER_DEVICE_ID" "smoke viewer")
JOINED=$(curl -fsS -X POST "$BASE/v1/sessions/join" -H "Authorization: Bearer $VIEWER_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"kind\":\"viewer\",\"display_name\":\"smoke viewer\"}")
echo "joined:        kind=$(echo "$JOINED" | j "['me']['kind']") color=$(echo "$JOINED" | j "['me']['color']") ($(echo "$JOINED" | j "len(d['participants'])") participants)"

curl -fsS -X POST "$BASE/v1/sessions/$SESSION_ID/keyframes" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"keyframes":[{"seq":1,"t":0.5,"pose":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"intrinsics":{"fx":213,"fy":213,"cx":128,"cy":96,"w":256,"h":192},"aligned":true}]}' >/dev/null && echo "keyframe:      registered"

LEFT=$(curl -fsS -X POST "$BASE/v1/sessions/$SESSION_ID/leave" -H "Authorization: Bearer $VIEWER_TOKEN")
echo "viewer left:   $(echo "$LEFT" | j "['left']")"
curl -fsS -X POST "$BASE/v1/sessions/$SESSION_ID/end" -H "Authorization: Bearer $TOKEN" >/dev/null && echo "party ended"
REJOIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/sessions/join" -H "Authorization: Bearer $VIEWER_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}")
echo "join ended:    HTTP $REJOIN_STATUS (expect 410)"

echo "admin network: $(curl -fsS "$BASE/admin/network?hours=1" -H "Authorization: Bearer $ADMIN_API_KEY" | j "['totals']['requests']") requests in the last hour"
curl -fsS -X DELETE "$BASE/v1/maps/$MAP_ID" -H "Authorization: Bearer $TOKEN" >/dev/null && echo "map deleted"
echo "OK"
