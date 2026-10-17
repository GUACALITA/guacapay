-- Subscriptions: a payee offers a recurring charge; the payer approves it once (limit and interval). Each period, the app charges.
-- The offer link token is stored only as a keyed hash.

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  offer_token_hash TEXT NOT NULL UNIQUE,
  payee_user_id TEXT NOT NULL REFERENCES users (id),
  payee_wallet_id TEXT NOT NULL REFERENCES wallets (id),
  payer_user_id TEXT REFERENCES users (id),
  payer_wallet_id TEXT REFERENCES wallets (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  -- One of the periods the app supports: P1D, P1W, P1M.
  interval TEXT NOT NULL CHECK (interval IN ('P1D', 'P1W', 'P1M')),
  grant_id TEXT REFERENCES grants (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'cancelled')),
  -- Consecutive failed charges. Three in a row pause the subscription.
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_charge_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_subscriptions_due ON subscriptions (status, next_charge_at);

-- One charge per period. The unique key stops a repeated job run from charging the same period twice.
CREATE TABLE subscription_charges (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id),
  period_start TEXT NOT NULL,
  transfer_id TEXT REFERENCES transfers (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (subscription_id, period_start)
);

-- A transfer may be made under a specific permission (a subscription's grant), not just the latest one.
ALTER TABLE transfers ADD COLUMN grant_id TEXT REFERENCES grants (id);
