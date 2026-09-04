-- Phase 2 §3: counters behind the cost estimates. One row per kind per request, written after the
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
