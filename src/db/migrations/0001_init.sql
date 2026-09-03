-- Ghostmap backend schema (Postgres / Neon)
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
