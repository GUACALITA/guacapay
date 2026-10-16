# 03 — Backend database

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Add the persistent store to the backend.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and the current `backend/` code before starting.

Steps:
1. Use SQLite through `better-sqlite3`. The database file path comes from `config.js` (new variable `DATABASE_PATH`, add it to `.env.example`). Write the decision and its reason in `docs/DECISIONS.md`: one service, no extra container, enough for the testnet stage.
2. Create a migration runner in `backend/src/migrate.js`. It applies `backend/migrations/NNN-name.sql` files in order, records each one in a `schema_migrations` table, and does nothing if a migration was already applied.
3. Create `backend/migrations/001-initial.sql` with these tables:
   - `users`: id, email (unique), created_at.
   - `otp_codes`: id, email, code_hash, expires_at, attempts, used_at.
   - `payments`: id, sender_id, recipient_email, amount_cents, currency, status, rapyd_checkout_id, created_at, updated_at.
   - `claims`: id, payment_id (unique), token_hash, status, destination, claimed_at, expires_at.
   - `payment_events`: id, payment_id, type, payload_json, created_at.
4. Create `backend/src/db.js` as the only module that opens the database or runs SQL.
5. Store OTP codes and claim tokens only as hashes. Use SHA-256 with a server-side secret (`HMAC_SECRET`). Write this rule in `docs/DECISIONS.md`.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets into any file.
- Do not add auth or payment logic.

Done when:
- Running migrations twice changes nothing the second time.
- All five tables exist with the columns above (check with a query).
- A test inserts a payment row and reads it back.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
