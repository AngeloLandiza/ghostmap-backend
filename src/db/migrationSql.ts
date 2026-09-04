// Generated from src/db/migrations/*.sql by `npm run db:sync` — do not edit by hand.
export const migrations: { name: string; sql: string }[] = [
  { name: '0001_init.sql', sql: `-- Ghostmap backend schema (Postgres / Neon)
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT 'ios',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS markers (
  id text PRIMARY KEY,
  family text NOT NULL DEFAULT 'tag36h11',
  size_m real NOT NULL DEFAULT 0.2,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maps (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  parent_map_id uuid REFERENCES maps(id),
  session_id uuid,
  device_id uuid REFERENCES devices(id),
  frame text NOT NULL DEFAULT 'world:session-start',
  origin jsonb NOT NULL DEFAULT '{"type":"session-start"}'::jsonb,
  status text NOT NULL DEFAULT 'uploading',
  manifest jsonb,
  point_count bigint NOT NULL DEFAULT 0,
  keyframe_count int NOT NULL DEFAULT 0,
  bbox jsonb,
  duration_s real NOT NULL DEFAULT 0,
  size_bytes bigint NOT NULL DEFAULT 0,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);
CREATE INDEX IF NOT EXISTS maps_created_idx ON maps (created_at DESC);
CREATE INDEX IF NOT EXISTS maps_session_idx ON maps (session_id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  origin jsonb NOT NULL DEFAULT '{"type":"session-start"}'::jsonb,
  leader_device_id uuid REFERENCES devices(id),
  base_map_id uuid REFERENCES maps(id),
  merged_map_id uuid REFERENCES maps(id),
  keyframe_count int NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id),
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (session_id, device_id)
);

CREATE TABLE IF NOT EXISTS keyframes (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id),
  seq int NOT NULL,
  t double precision NOT NULL,
  pose real[] NOT NULL,
  intrinsics jsonb NOT NULL,
  tracking_state text NOT NULL DEFAULT 'normal',
  world_mapping_status text NOT NULL DEFAULT 'unknown',
  depth_ref text,
  confidence_ref text,
  jpeg_ref text,
  mesh_ref text,
  points_inline jsonb,
  bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, device_id, seq)
);
CREATE INDEX IF NOT EXISTS keyframes_session_idx ON keyframes (session_id, id);

CREATE TABLE IF NOT EXISTS merge_jobs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  requested_by uuid,
  input_map_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_map_id uuid REFERENCES maps(id),
  error text,
  cloud_run_execution text,
  worker text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS merge_jobs_status_idx ON merge_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS api_usage (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  route text NOT NULL,
  status int NOT NULL,
  duration_ms int NOT NULL,
  bytes_in int NOT NULL DEFAULT 0,
  bytes_out int NOT NULL DEFAULT 0,
  region text,
  country text,
  role text,
  device_id uuid
);
CREATE INDEX IF NOT EXISTS api_usage_ts_idx ON api_usage (ts DESC);

CREATE TABLE IF NOT EXISTS stats_cache (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
` },
  { name: '0002_accounts_parties.sql', sql: `-- Phase 2 §1-§2: Google accounts, ownership/visibility and collaborative parties.
-- Every statement is idempotent; the runner splits on ";\\n" so multi-line DO blocks are written on one line.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  google_sub text NOT NULL,
  email text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  picture_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_key ON users (google_sub);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

ALTER TABLE devices ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);

ALTER TABLE maps ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS maps_owner_idx ON maps (owner_user_id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS max_participants int NOT NULL DEFAULT 4;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_invite_code_key ON sessions (invite_code);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions (owner_user_id);

-- Viewers participate without a device, so device_id becomes nullable and a surrogate id replaces the
-- (session_id, device_id) primary key. Partial unique indexes keep one row per device and per viewer.
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'device';
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE session_participants DROP CONSTRAINT IF EXISTS session_participants_pkey;
ALTER TABLE session_participants ALTER COLUMN device_id DROP NOT NULL;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'session_participants'::regclass AND contype = 'p') THEN ALTER TABLE session_participants ADD CONSTRAINT session_participants_pkey PRIMARY KEY (id); END IF; END $do$;
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_device_key ON session_participants (session_id, device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_participants_viewer_key ON session_participants (session_id, user_id) WHERE device_id IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_participants_user_idx ON session_participants (user_id);

-- false when the pose is still in the device's own frame (no marker seen yet).
ALTER TABLE keyframes ADD COLUMN IF NOT EXISTS aligned boolean NOT NULL DEFAULT true;
` },
  { name: '0003_usage_events.sql', sql: `-- Phase 2 §3: counters behind the cost estimates. One row per kind per request, written after the
-- response through waitUntil, so the table stays small and the write is never on the critical path.
-- Every statement is idempotent.

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  count int NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_kind_ts_idx ON usage_events (kind, ts DESC);
` },
]
