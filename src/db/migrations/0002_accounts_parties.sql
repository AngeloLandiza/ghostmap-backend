-- Phase 2 §1-§2: Google accounts, ownership/visibility and collaborative parties.
-- Every statement is idempotent; the runner splits on ";\n" so multi-line DO blocks are written on one line.

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
