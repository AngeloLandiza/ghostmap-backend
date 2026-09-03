# 5. Merge jobs and the Cloud Run worker

## What this feature gives you
When a session ends, the leader calls `POST /v1/sessions/:id/merge`. The backend records a merge job listing the input maps (the base map plus every map saved during the session) and either starts a Cloud Run Job (when `CLOUD_RUN_MERGE_JOB` is set) or leaves it queued for a worker that polls `POST /v1/merge-jobs/next`. The worker downloads the inputs, merges them (Open3D registration, later RTAB-Map as in the MVP plan), uploads the result as a new map version and calls `POST /v1/merge-jobs/:id/complete`.

The worker itself is not part of this repo; this is its contract.

## Worker contract
1. Authenticate with `WORKER_API_KEY` (as the bearer token).
2. Get work: `POST /v1/merge-jobs/next` (pull) or receive `--merge-job <id>` as a Cloud Run job argument (push), then `POST /v1/merge-jobs/:id/claim`.
3. For each `input_map_ids[i]`: `GET /v1/maps/:id` → download `cloud.ply` (and `keyframes.bin` if you re-integrate depth) from the signed URLs. For live sessions also `GET /v1/sessions/:id/keyframes?urls=1` to fetch per-device depth blobs.
4. Merge in the session origin frame (marker frame when the session used a marker, otherwise register clouds with global registration + ICP).
5. Publish the result: `POST /v1/maps` (with the worker/admin token) → upload files with the signed URLs → `POST /v1/maps/:id/finalize` with `parent_map_id` set to the base map so the version increments.
6. `POST /v1/merge-jobs/:id/complete` with `{ "output_map_id": "<new map>" }` or `{ "error": "…" }`.

## Cloud Run Job (push mode)
```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
# build your worker image, then:
gcloud run jobs create ghostmap-merge --image=us-east1-docker.pkg.dev/ghostmap-prod/ghostmap/merge:latest \
  --region=us-east1 --memory=4Gi --cpu=2 --task-timeout=30m \
  --set-env-vars=API_BASE=https://<app>.vercel.app,WORKER_API_KEY=<key>
gcloud projects add-iam-policy-binding ghostmap-prod \
  --member="serviceAccount:ghostmap-api@ghostmap-prod.iam.gserviceaccount.com" --role="roles/run.developer"
```
Set `CLOUD_RUN_REGION=us-east1` and `CLOUD_RUN_MERGE_JOB=ghostmap-merge` in Vercel. The API calls `jobs.run` with `--merge-job <id>` as the container argument and stores the execution name on the job.

## Verify
`POST /v1/sessions/:id/end` then `POST /v1/sessions/:id/merge` → `202`; `GET /v1/merge-jobs?session_id=…` shows `queued` → `running` → `succeeded`; the session's `merged_map_id` points at the new map and the channel receives a `merge` message.
