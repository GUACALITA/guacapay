-- A transfer moves money from a linked wallet to another wallet. It is made of legs, one per Open Payments object.
-- Each leg is stored before its call, so a retry reuses it instead of creating a second one.

CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  payment_id TEXT REFERENCES payments (id),
  from_wallet_id TEXT NOT NULL REFERENCES wallets (id),
  to_wallet_url TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE transfer_legs (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers (id),
  kind TEXT NOT NULL CHECK (kind IN ('incoming', 'quote', 'outgoing')),
  remote_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (transfer_id, kind)
);

CREATE INDEX idx_transfers_payment ON transfers (payment_id);
