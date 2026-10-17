-- Payment requests: a user asks to be paid. The payer's transfer goes straight to the requester's wallet (no custody, no claim).
-- The public link token is stored only as a keyed hash (see backend/src/hash.js).

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users (id),
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'closed')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  -- Set while a payer's transfer is running; cleared again if that transfer fails for good.
  paying_transfer_id TEXT REFERENCES transfers (id),
  paid_by_user_id TEXT REFERENCES users (id),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payment_requests_owner ON payment_requests (owner_user_id, created_at);

-- A request transfer belongs to a request, not to a payment.
ALTER TABLE transfers ADD COLUMN request_id TEXT REFERENCES payment_requests (id);
CREATE INDEX idx_transfers_request ON transfers (request_id);

-- Shown on a public request page, when set. Empty until the profile is added.
ALTER TABLE users ADD COLUMN first_name TEXT;
