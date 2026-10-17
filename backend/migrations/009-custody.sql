-- The custody ledger: money the platform holds in its custody wallet for each payment.
-- 'in' is written when the pay-in transfer completes; 'out' when the payout completes. Written in the same transaction as the payment change.

CREATE TABLE custody_entries (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  -- NULL only when the transfer step returned no transfer record (test doubles).
  transfer_id TEXT REFERENCES transfers (id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (transfer_id, direction)
);

CREATE INDEX idx_custody_entries_payment ON custody_entries (payment_id);

-- Out entries may never exceed the in entries of the same payment. The database refuses the write, not only the service.
CREATE TRIGGER custody_out_within_in
BEFORE INSERT ON custody_entries
WHEN NEW.direction = 'out' AND (
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount_cents ELSE -amount_cents END), 0)
  FROM custody_entries WHERE payment_id = NEW.payment_id
) < NEW.amount_cents
BEGIN
  SELECT RAISE(ABORT, 'custody_out_exceeds_in');
END;
