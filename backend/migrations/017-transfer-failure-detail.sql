-- The full reason a transfer failed, as the network reported it. failure_code stays the short stable code.
ALTER TABLE transfers ADD COLUMN failure_detail TEXT;
