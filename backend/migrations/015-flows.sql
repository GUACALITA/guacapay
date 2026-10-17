-- Parametrizable payment flows with post-quantum integrity signatures.
-- A flow is a reusable template: one record stores type + config, then it is "run"
-- by creating a real payment, split, pool, subscription, or request.
-- pq_sig: ML-DSA-65 signature of (id + user_id + type + config_json).

ALTER TABLE payments ADD COLUMN pq_sig TEXT;

CREATE TABLE IF NOT EXISTS flows (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,         -- 'cobro' | 'tanda' | 'vaca' | 'cuenta' | 'suscripcion'
  title       TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  pq_sig      TEXT,
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'archived'
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS flows_user_id ON flows(user_id);
