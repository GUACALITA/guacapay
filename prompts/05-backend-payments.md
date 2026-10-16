# 05 — Backend payments

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Add the internal payment lifecycle to the backend. This layer does not know any payment provider.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, `docs/DECISIONS.md`, and the current `backend/` code before starting. The `payments` and `payment_events` tables already exist (prompt 03).

Steps:
1. Define the states: `created`, `awaiting_payment`, `paid`, `claimable`, `claimed`, `completed`, `expired`, `failed`.
2. Write the allowed transitions in one table in `backend/src/payments/states.js`. Any transition not in the table throws an error. Examples of allowed: `created` → `awaiting_payment`, `awaiting_payment` → `paid`, `paid` → `claimable`, `claimable` → `claimed`, `claimed` → `completed`. Example of forbidden: `claimed` → `created`.
3. `POST /api/payments` (requires auth): body `{ recipient_email, amount_cents, currency, message? }`.
   - Validate the recipient email, that `amount_cents` is an integer within configured minimum and maximum, and that currency is in an allowed list.
   - Create the payment in state `created`.
   - Accept an `Idempotency-Key` header. The same key from the same user returns the same payment and does not create a second one.
4. `GET /api/payments/:id` and `GET /api/payments` return only the authenticated user's payments. For another user's payment, return 404.
5. Every state change writes one row to `payment_events` in the same database transaction as the state change.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Do not call Rapyd or Open Payments in this prompt.
- Never write real secrets into any file.

Done when:
- A forbidden transition throws, and the test checks it.
- Two identical requests with the same `Idempotency-Key` create one payment.
- Every state change has exactly one event row.
- User A gets 404 when requesting User B's payment.
- Tests for each rule above pass.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
