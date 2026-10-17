-- Consent grants for a wallet. Tokens are stored encrypted; the callback nonce is stored as a hash.

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets (id),
  purpose TEXT NOT NULL CHECK (purpose IN ('link', 'recurring')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'expired', 'revoked')),
  access_limits_json TEXT,
  continue_uri TEXT,
  continue_token_enc TEXT,
  access_token_enc TEXT,
  nonce_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  granted_at TEXT,
  expires_at TEXT
);

CREATE INDEX idx_grants_wallet ON grants (wallet_id);
