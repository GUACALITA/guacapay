-- Group pools: a collection (everyone pays a share toward one goal) or a tanda (a rotating circle: each period, the whole pool goes to one member).
-- The pool's money sits in the custody wallet, recorded per pool in the custody ledger.
-- The join link token is stored only as a keyed hash.

CREATE TABLE pools (
  id TEXT PRIMARY KEY,
  organizer_user_id TEXT NOT NULL REFERENCES users (id),
  organizer_wallet_id TEXT NOT NULL REFERENCES wallets (id),
  kind TEXT NOT NULL CHECK (kind IN ('collection', 'tanda')),
  -- Collection only: the goal, and an optional closing date after which the total is paid out.
  goal_cents INTEGER CHECK (goal_cents IS NULL OR goal_cents > 0),
  closes_at TEXT,
  -- Tanda only: how often a period falls due.
  period TEXT CHECK (period IS NULL OR period IN ('P1W', 'P1M')),
  share_cents INTEGER NOT NULL CHECK (share_cents > 0),
  currency TEXT NOT NULL,
  -- Member user IDs in payout order, written when the pool starts.
  order_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('forming', 'active', 'closing', 'completed', 'cancelled')),
  -- Tanda: the period being collected (1-based). Collection: always 1 once started.
  current_period INTEGER NOT NULL DEFAULT 0,
  period_due_at TEXT,
  join_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'collection' AND goal_cents IS NOT NULL) OR (kind = 'tanda' AND period IS NOT NULL))
);

-- A member's position is the period in which they receive the pool (tanda). Collection positions only set the order of joining.
CREATE TABLE pool_members (
  pool_id TEXT NOT NULL REFERENCES pools (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  grant_id TEXT NOT NULL REFERENCES grants (id),
  position INTEGER NOT NULL CHECK (position > 0),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (pool_id, user_id),
  UNIQUE (pool_id, position)
);

-- One contribution per member per period. The unique key refuses a second one.
CREATE TABLE pool_contributions (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  period INTEGER NOT NULL CHECK (period > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  transfer_id TEXT REFERENCES transfers (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (pool_id, user_id, period)
);

-- One payout per pool period: the whole amount of that period's contributions, sent from custody to one wallet.
CREATE TABLE pool_payouts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools (id),
  period INTEGER NOT NULL CHECK (period > 0),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  transfer_id TEXT REFERENCES transfers (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (pool_id, period)
);

-- Custody entries can belong to a payment or to a pool. Nothing references this table, so it is rebuilt.
DROP TRIGGER custody_out_within_in;

CREATE TABLE custody_entries_new (
  id TEXT PRIMARY KEY,
  payment_id TEXT REFERENCES payments (id),
  pool_id TEXT REFERENCES pools (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  transfer_id TEXT REFERENCES transfers (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (transfer_id, direction),
  CHECK ((payment_id IS NULL) <> (pool_id IS NULL))
);

INSERT INTO custody_entries_new (id, payment_id, pool_id, amount_cents, currency, direction, transfer_id, created_at)
  SELECT id, payment_id, NULL, amount_cents, currency, direction, transfer_id, created_at FROM custody_entries;

DROP TABLE custody_entries;
ALTER TABLE custody_entries_new RENAME TO custody_entries;

CREATE INDEX idx_custody_entries_payment ON custody_entries (payment_id);
CREATE INDEX idx_custody_entries_pool ON custody_entries (pool_id);

-- Out entries may never exceed the in entries of the same payment or pool. The database refuses the write.
CREATE TRIGGER custody_out_within_in
BEFORE INSERT ON custody_entries
WHEN NEW.direction = 'out' AND (
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0)
  FROM custody_entries
  WHERE payment_id IS NEW.payment_id AND pool_id IS NEW.pool_id
) < NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'custody_out_exceeds_in');
END;
