# 3. Google Cloud Storage for maps and keyframes

## What this feature gives you
`POST /v1/maps` returns V4 signed URLs so the phone uploads `cloud.ply`, `keyframes.bin`, `manifest.json`, `thumbnail.png`, `worldmap.arworldmap` and `session.log` straight to GCS, then `POST /v1/maps/:id/finalize` verifies the objects and publishes the map. During a session, `POST /v1/sessions/:id/upload-urls` signs per-keyframe depth/confidence/JPEG blobs in batches (up to 100 at once), so every keyframe is in the cloud within a second of capture. Reads go through short-lived signed GET URLs. Nothing large ever passes through Vercel (4.5 MB body limit).

## Steps
1. **Project and bucket**
   ```bash
   gcloud projects create ghostmap-prod --name="Ghostmap" && gcloud config set project ghostmap-prod
   gcloud services enable storage.googleapis.com iam.googleapis.com
   gcloud storage buckets create gs://ghostmap-maps --location=US-EAST1 --uniform-bucket-level-access --public-access-prevention
   ```
2. **Service account** with object access only on that bucket:
   ```bash
   gcloud iam service-accounts create ghostmap-api --display-name="Ghostmap API"
   gcloud storage buckets add-iam-policy-binding gs://ghostmap-maps \
     --member="serviceAccount:ghostmap-api@ghostmap-prod.iam.gserviceaccount.com" --role="roles/storage.objectAdmin"
   gcloud iam service-accounts keys create sa-key.json --iam-account=ghostmap-api@ghostmap-prod.iam.gserviceaccount.com
   base64 -i sa-key.json | tr -d '\n' > sa-key.b64      # value for GCP_SA_KEY_B64
   ```
   Set `GCP_PROJECT_ID`, `GCS_BUCKET`, `GCP_SA_KEY_B64` in Vercel. Delete `sa-key.json` from disk afterwards; it is git-ignored.
3. **CORS on the bucket** so the web app can upload/download with signed URLs from the browser:
   ```bash
   cat > cors.json <<'JSON'
   [{"origin": ["https://ghostmap.vercel.app", "https://ghostmap-dashboard.vercel.app", "https://ghostmap-dashboard-*.vercel.app", "http://localhost:5173"],
     "method": ["GET", "PUT", "POST", "HEAD"],
     "responseHeader": ["Content-Type", "x-goog-resumable", "Location", "Content-Range"],
     "maxAgeSeconds": 3600}]
   JSON
   gcloud storage buckets update gs://ghostmap-maps --cors-file=cors.json
   ```
4. **Lifecycle** (optional): expire raw session keyframes after 30 days once they have been merged:
   ```bash
   cat > lifecycle.json <<'JSON'
   {"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["sessions/"]}}]}
   JSON
   gcloud storage buckets update gs://ghostmap-maps --lifecycle-file=lifecycle.json
   ```
5. **Verify**: `scripts/smoke.sh https://<app>` creates a map, prints the signed URLs and deletes it; or `GET /admin/storage`.

## Object layout
```
maps/<mapId>/{manifest.json,keyframes.bin,cloud.ply,thumbnail.png,worldmap.arworldmap,session.log}
sessions/<sessionId>/kf/<deviceId>/<seq>.depth.lzfse | .conf.lzfse | .jpg | .mesh.bin
```

## Client upload recipe
Single PUT (small files): `PUT <url>` with `Content-Type` exactly as returned. Resumable (`cloud.ply`, `keyframes.bin`): `POST <url>` with headers `Content-Type` and `x-goog-resumable: start`, empty body → read `Location` → `PUT` the bytes there (URLSession `uploadTask` on iOS; chunked with `Content-Range: bytes a-b/total` for very large files).
