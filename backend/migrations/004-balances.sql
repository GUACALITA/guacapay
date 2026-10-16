-- App balance per user and currency, its movements, and whether a payment is a transfer or a recharge.

ALTER TABLE payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'transfer';

CREATE TABLE balances (
  user_id TEXT NOT NULL REFERENCES users (id),
  currency TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payment_id TEXT REFERENCES payments (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_ledger_user ON ledger_entries (user_id);
