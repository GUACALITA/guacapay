-- The URL the wallet provides to rotate an access token before it expires.
ALTER TABLE grants ADD COLUMN access_token_manage TEXT;
