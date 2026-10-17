-- Deposits and withdrawals. A deposit moves money from the user's wallet into custody and credits their app balance, backed by custody.
-- A withdrawal moves money from custody to the user's own wallet, only up to what is backed for that user.

-- Custody entries can belong to a payment, a pool, or a user (the user's backed balance). Nothing references this table, so it is rebuilt.
DROP TRIGGER custody_out_within_in;

CREATE TABLE custody_entries_new (
  id TEXT PRIMARY KEY,
  payment_id TEXT REFERENCES payments (id),
  pool_id TEXT REFERENCES pools (id),
  user_id TEXT REFERENCES users (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  transfer_id TEXT REFERENCES transfers (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (transfer_id, direction),
  CHECK ((payment_id IS NOT NULL) + (pool_id IS NOT NULL) + (user_id IS NOT NULL) = 1)
);

INSERT INTO custody_entries_new (id, payment_id, pool_id, user_id, amount_cents, currency, direction, transfer_id, created_at)
  SELECT id, payment_id, pool_id, NULL, amount_cents, currency, direction, transfer_id, created_at FROM custody_entries;

DROP TABLE custody_entries;
ALTER TABLE custody_entries_new RENAME TO custody_entries;

CREATE INDEX idx_custody_entries_payment ON custody_entries (payment_id);
CREATE INDEX idx_custody_entries_pool ON custody_entries (pool_id);
CREATE INDEX idx_custody_entries_user ON custody_entries (user_id, currency);

-- Out entries may never exceed the in entries of the same owner (payment, pool or user). The database refuses the write.
CREATE TRIGGER custody_out_within_in
BEFORE INSERT ON custody_entries
WHEN NEW.direction = 'out' AND (
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0)
  FROM custody_entries
  WHERE payment_id IS NEW.payment_id AND pool_id IS NEW.pool_id AND user_id IS NEW.user_id
) < NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'custody_out_exceeds_in');
END;

CREATE TABLE deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  transfer_id TEXT REFERENCES transfers (id),
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_deposits_user ON deposits (user_id, created_at);

CREATE TABLE withdrawals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  transfer_id TEXT REFERENCES transfers (id),
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_withdrawals_user ON withdrawals (user_id, created_at);

-- Balance movements for deposits and withdrawals refer to these rows, not to payments.
ALTER TABLE ledger_entries ADD COLUMN reference_id TEXT;
