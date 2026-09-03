# 6. Wiring the iOS app and the website

## iOS (Ghostmap app)
1. Ship one value from `CLIENT_ACCESS_KEYS` in the app (Keychain or a build setting) and a stable device UUID (`UIDevice.identifierForVendor` or a generated UUID stored in Keychain).
2. On launch: `POST /v1/auth/token` `{ access_key, device: { id, name, platform: "ios" } }` → store the JWT; refresh when `expires_at` is near.
3. **After a local map is saved**: `POST /v1/maps` `{ name, frame, origin, files }` → for each `uploads[]` entry upload the file from the map folder (`URLSession.uploadTask`; resumable for `cloud.ply` / `keyframes.bin`) → `POST /v1/maps/:id/finalize` with the manifest JSON. The map is now in the cloud and visible to the website.
4. **Collaborative session**: leader `POST /v1/sessions` (origin `marker` + `marker_id` when everyone scans the same printed tag); others `POST /v1/sessions/:id/join`. During capture, for every keyframe: `POST /v1/sessions/:id/upload-urls` in batches of ~10 → PUT depth + confidence blobs (the same LZFSE payloads written to `keyframes.bin`) → `POST /v1/sessions/:id/keyframes` with pose, intrinsics and up to 2 000 inline decimated points. Subscribe to the Ably channel via `POST /v1/realtime/token` to draw the other phones' points. Leader ends and merges.
5. Extension point in the app: `KeyframeProcessor` already produces `KeyframeRecord` (pose, intrinsics, u16-mm depth, confidence) and the encoder used by `KeyframeLog`; an `Uploader` actor that batches those records maps 1:1 onto the endpoints above.

## Website (Vite + three.js, on Vercel)
1. Exchange a client access key for a `client` JWT (`POST /v1/auth/token` without `device`) — or proxy that through your own login later.
2. Map library: `GET /v1/maps` → cards; `GET /v1/maps/:id` → `downloads["cloud.ply"].url` → load with three.js `PLYLoader`; thumbnails from `downloads["thumbnail.png"]`.
3. Live view: `GET /v1/sessions?status=active` → `POST /v1/realtime/token { session_id }` → Ably subscribe (`keyframes` messages carry `points_inline` and poses) and catch up with `GET /v1/sessions/:id/keyframes?since_id=0&urls=1`.
4. CORS: add the site's origin to `ALLOWED_ORIGINS` (previews on `*.vercel.app` are allowed automatically) and to the bucket CORS (guide 3) because signed URL downloads go straight to GCS.
