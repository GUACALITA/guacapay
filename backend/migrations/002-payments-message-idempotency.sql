-- Payment message and per-sender idempotency keys.

ALTER TABLE payments ADD COLUMN message TEXT;
ALTER TABLE payments ADD COLUMN idempotency_key TEXT;

-- Same key from the same sender always maps to the same payment.
-- Partial index: payments created without a key are not constrained.
CREATE UNIQUE INDEX idx_payments_idempotency
  ON payments (sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
