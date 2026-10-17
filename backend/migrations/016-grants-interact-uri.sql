-- Store the Interledger approval URL so it can be shown in the UI without re-requesting the grant.
ALTER TABLE grants ADD COLUMN interact_uri TEXT;
