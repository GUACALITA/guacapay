# 20 — Grants and consent

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Ask a user's wallet for permission, once, and reuse that permission later. Permissions are the Open Payments grants.

Context: read prompt 18 (the client module) and `docs/OPEN_PAYMENTS.md`. Verified in the test network on 2026-10-16: a grant for `quote` is approved without interaction; a grant for `outgoing-payment` needs one approval in the wallet's own page, which returns a redirect URL and a callback URL with `interact_ref`.

Steps:
1. Migration `backend/migrations/006-grants.sql`: table `grants` with `id`, `wallet_id`, `purpose` (`link`, `send`, `recurring`), `status` (`pending`, `granted`, `expired`, `revoked`), `access_limits_json`, `continue_uri`, `continue_token_enc`, `nonce_hash`, `created_at`, `expires_at`.
2. Encrypt `continue_token_enc` with a key from the environment (`GRANT_ENCRYPTION_KEY`, 32 bytes, documented in `.env.example`). Never log it.
3. `backend/src/grants/service.js`:
   - `requestConsent(walletId, purpose, limits)`: creates the grant with the SDK, stores the continue data, returns the approval URL.
   - `finishConsent(grantId, interactRef)`: continues the grant with `interact_ref` and stores the access token, encrypted.
   - `getAccessToken(grantId)`: returns a usable token, or `grant_expired` so the user can consent again.
4. Routes: `POST /api/grants` (start), `GET /api/grants/callback` (the wallet returns here with `interact_ref`; the route validates the nonce and redirects the user to the wallet page), `POST /api/grants/:id/revoke`.
5. The nonce is random per request, stored as a hash, and checked on callback.

Constraints:
- Limits are explicit: a debit limit in the wallet's asset, and optionally an interval for recurring grants (prompt 25).
- Tests use the fake Open Payments server, including a pending grant that is later finished.
- Everything in English. No commits.

Done when:
- A consent round trip works in tests: start, callback with `interact_ref`, token stored encrypted.
- A wrong nonce on callback is refused.
- A stored token is not visible in the database as plain text, or in any log.
- Manual check (reported): one real approval in the test wallet, followed by a finished grant.

**Depends on:** the approval step in the test wallet (manual).

At the end, list every file changed and the result of each check.
