# 12 — Claim flow

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Let the recipient claim a paid payment: prove their email, choose a testnet wallet, and receive the transfer.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, `docs/DECISIONS.md`, `docs/OPEN_PAYMENTS.md`, and the current code. Prompts 03 through 11 must be complete first.

Steps:
1. When a payment becomes `paid`, create a `claims` row. Generate a random token of at least 32 bytes. Store only its hash. Move the payment to `claimable`. Send the link `BASE_URL/claim.html?token=<token>` by email (prompt 13).
2. `POST /api/claims/verify-email` with `{ token, email }`: check the token and that the email matches the payment's `recipient_email`. Then send a one-time code using the auth flow (prompt 04).
3. `POST /api/claims/confirm` with `{ token, code, destinationWalletAddress }`: verify the code. Validate the destination as an Open Payments wallet address. Only testnet addresses are accepted in this stage; put the allowed list in config.
4. On confirm, set the claim to `claimed`, then run the transfer from prompt 08, then set the payment to `completed`. If the transfer fails, set the payment to `failed` and record the reason in `payment_events`. Do not retry automatically.
5. Claim tokens expire after 7 days and can be used once. A second use returns a clear error.
6. `frontend/claim.html`: email step, code step, destination step, result. No internal details shown.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never log the token or the code.
- Never write real secrets into any file.

Done when:
- A valid link works once; the second use is rejected.
- An expired token is rejected.
- A wrong email for the claim is rejected.
- A full run on testnet ends with the payment `completed` and a confirmation email to the sender (manual check, report it).
- A failed transfer leaves the payment `failed` with an event row.

At the end, list every file created or changed with its full path, and the output of each "Done when" check. Say which checks ran on the live testnet and which were mocked.
