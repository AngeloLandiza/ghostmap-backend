# 4. Ably realtime for collaborative sessions

## What this feature gives you
Vercel functions cannot hold WebSockets, so live fan-out runs on Ably. Each session has a channel `session:<id>`. The backend publishes `keyframes`, `participant`, `session` and `merge` messages when clients call the REST endpoints, and mints **token requests** so no client ever holds the API key. Devices in a session may also publish their own lightweight `live` messages (poses at 10–30 Hz) directly on the channel.

## Steps
1. ably.com → Create app "ghostmap" → API Keys → create a key with capabilities **publish, subscribe, presence, history** on `session:*` (or all channels). Copy `appId.keyId:secret` into `ABLY_API_KEY`.
2. Redeploy; `GET /admin/health` should show `ably.ok = true`.
3. Client side (JavaScript):
   ```js
   import * as Ably from 'ably'
   const ably = new Ably.Realtime({
     authCallback: async (_, cb) => {
       const r = await fetch(`${API}/v1/realtime/token`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id }) })
       cb(null, (await r.json()).token_request)
     },
   })
   const ch = ably.channels.get(`session:${session_id}`)
   ch.subscribe('keyframes', (m) => render(m.data.keyframes))   // poses + inline points; depth blobs via GET /v1/sessions/:id/keyframes?urls=1
   ch.presence.enter({ role: 'viewer' })
   ```
   Swift: use the Ably Cocoa SDK with `ARTClientOptions.authCallback` doing the same request.
4. Message size: keep `points_inline` ≤ 2 000 points (the API enforces it) so messages stay far below Ably's 64 KB limit.

## Notes
- The free tier (6 M messages/month) covers several hours of 3-phone sessions per day; check the Ably dashboard's "Messages" chart.
- Token requests are valid for 1 hour; the SDK refreshes automatically through `authCallback`.
