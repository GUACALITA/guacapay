-- How a payment is paid: from a linked test wallet (the product path), from the app balance (internal), or by card (development only).
-- Each transfer is either money coming in to custody ('in': sender wallet to custody) or going out to a recipient ('out': custody to recipient).

ALTER TABLE payments ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'wallet'
  CHECK (payment_method IN ('wallet', 'balance', 'rapyd'));

ALTER TABLE transfers ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'
  CHECK (direction IN ('in', 'out'));
