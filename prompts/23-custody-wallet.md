# 23 — Custody wallet and its ledger

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/009-custody.sql`, `backend/src/custody/service.js`, `backend/src/custody/routes.js`, `backend/test/custody.test.js`; edited `backend/src/transfers/payments.js` (`recordIn` when pay-in completes), `backend/src/claims/service.js` (`assertCustodyHolds` before the code is used, `recordOut` when the payout completes), `backend/src/app.js` (`/api/custody`), `backend/src/server.js` (start-up check), `backend/test/claims.test.js`, `backend/test/email.test.js`, `backend/test/integration.test.js` (seed custody money before a claim, since payouts are refused without it)

**Choices made in this step:**
- The "out never exceeds in" rule is enforced twice: by a database trigger, and by `assertCustodyHolds` before any money is sent. The service check runs before the claim code is used, so a refusal does not force a new code.
- `custody_entries.transfer_id` is nullable, for the test double that returns no transfer record. Entries from the engine always have it.
- The start-up check only logs. Missing custody config is a warning, because the rest of the app runs without it.
- The operator endpoint uses the gateway token, not a user session.

**Not verified yet:**
- The wallet document on the test network has no balance field this app reads, so reconciliation reports `not_available_from_api`. This is an assumption to check against a real wallet document.
- `checkCustodyWallet` compares the stored wallet URL with the configured address exactly; a trailing-slash difference would report `address_mismatch`.

**Open gap (not in this prompt):** payments paid from app balance or by the card rail never put money in custody, so their claims are refused with `custody_out_exceeds_in` and nothing is sent. Decide whether those rails stay out of claims.

## Prompt

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
