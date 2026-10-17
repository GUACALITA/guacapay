-- Test wallets linked to users. A wallet belongs to one user at a time; a revoked wallet can be linked again.

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  wallet_url TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  asset_scale INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  linked_at TEXT
);

-- One active owner per wallet address.
CREATE UNIQUE INDEX idx_wallets_active_url ON wallets (wallet_url) WHERE status != 'revoked';
CREATE INDEX idx_wallets_user ON wallets (user_id);
