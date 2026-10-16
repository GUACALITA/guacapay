-- Initial schema. Timestamps are ISO 8601 UTC strings.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Codes are stored only as hashes (see backend/src/hash.js).
CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_otp_codes_email ON otp_codes (email);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users (id),
  recipient_email TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  rapyd_checkout_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payments_sender ON payments (sender_id);
CREATE INDEX idx_payments_status ON payments (status);

-- Claim tokens are stored only as hashes (see backend/src/hash.js).
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments (id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  destination TEXT,
  claimed_at TEXT,
  expires_at TEXT NOT NULL
);

-- Audit trail: one row per state change.
CREATE TABLE payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_payment_events_payment ON payment_events (payment_id);
