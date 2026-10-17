# 23 — Custody wallet and its ledger

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

The platform holds money for payments that are not yet claimed, in one test wallet called the custody wallet. Every amount that goes in or out is recorded in our ledger, so we can show who the money belongs to.

Context: read prompts 18, 20, 21 and 22, and `backend/src/balance/` (the existing app balance ledger).

Steps:
1. Config: `CUSTODY_WALLET_ADDRESS` (the platform's test wallet). Start-up check: the wallet exists and the platform key is linked to it.
2. Migration `backend/migrations/009-custody.sql` (008 is used by prompt 22): table `custody_entries` (`id`, `payment_id`, `amount_cents`, `currency`, `direction` = `in` | `out`, `transfer_id`, `created_at`). An `in` entry is written when transfer 1 completes; an `out` entry when transfer 2 completes.
3. `backend/src/custody/service.js`:
   - `custodyBalance(currency)`: the sum of entries. It must never be negative.
   - `recordIn` and `recordOut`, always inside the transaction that changes the payment.
   - `reconcile()`: compares the ledger sum with the custody wallet's public document, when the document shows a balance. If the document has no balance field, it reports "not available from the API" instead of guessing.
4. An internal admin endpoint for the operator only: `GET /api/custody` (protected by the gateway-style token from prompt 04, not by user sign-in).

Constraints:
- Out entries may never exceed the in entries for the same payment (checked in the database layer and the service).
- The custody wallet's private material is never exposed by any endpoint.
- Everything in English. No commits.

Done when:
- Tests: an `in` followed by an `out` leaves the custody balance at zero for that payment.
- Tests: an `out` larger than the `in` is refused.
- The custody balance is visible to the operator endpoint and not to users.
- The reconcile report says clearly when the API cannot show a balance.

At the end, list every file changed and the result of each check.
