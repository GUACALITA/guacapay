-- One payment split among several recipients. Each part is a child payment with its own claim.
-- status: pending (some child still in progress), completed (every child completed), partial (finished, with at least one child failed or expired).

CREATE TABLE split_payments (
  id TEXT PRIMARY KEY,
  payer_user_id TEXT NOT NULL REFERENCES users (id),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'partial')),
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A repeated request with the same key returns the first split instead of paying again.
CREATE UNIQUE INDEX idx_splits_idempotency ON split_payments (payer_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE payments ADD COLUMN parent_split_id TEXT REFERENCES split_payments (id);
CREATE INDEX idx_payments_split ON payments (parent_split_id);
