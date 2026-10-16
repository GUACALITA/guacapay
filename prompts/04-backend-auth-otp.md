# 04 — Backend auth (one-time code)

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16, all checks passed (20/20 automated, container checked). Login completes only after prompt 13 supplies email delivery.
**Files produced:** `backend/src/app.js`, `backend/src/auth/{service,tokens,middleware,mailer,routes}.js`, `backend/src/rate-limit.js`, `backend/test/auth.test.js`; edited `backend/src/server.js` (now uses `app.js`), `backend/package.json` (jsonwebtoken), `docs/DECISIONS.md` (decision 005)

## Prompt

Add email login with a one-time code to the backend.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, `docs/DECISIONS.md`, and the current `backend/` code before starting. The `otp_codes` and `users` tables already exist (prompt 03).

Steps:
1. `POST /api/auth/request-code` with body `{ "email" }`:
   - Validate the email format.
   - Generate a random 6-digit code with a cryptographically secure generator.
   - Store only its hash, with an expiry of 10 minutes.
   - Send the code by email through the email module (prompt 13). For now, call a function `sendLoginCode(email, code)` that is stubbed behind an interface.
   - Always return the same response, whether or not the email exists, to avoid account enumeration.
2. `POST /api/auth/verify-code` with body `{ "email", "code" }`:
   - Reject if the code is expired, already used, or has 5 or more attempts.
   - Compare hashes with a constant-time function.
   - On success, mark the code used, create the user if needed, and return a JWT valid for 1 hour. The JWT carries the user ID and nothing secret.
3. Rate limits: `request-code` allows 3 requests per email per 15 minutes and 10 per IP per 15 minutes. Return 429 when exceeded.
4. Create middleware `requireAuth` that reads `Authorization: Bearer <token>` and sets `req.user`. Return 401 when missing or invalid.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never log the code or the token.
- Never write real secrets into any file. Tests use placeholder secrets.

Done when:
- A correct code returns a token.
- Five wrong codes in a row block the next attempt, even if it is correct.
- An expired code is rejected.
- The fourth `request-code` within 15 minutes returns 429.
- A protected route without a token returns 401.
- The same response shape is returned for a known and an unknown email.
- Tests for each rule above pass.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
