# 28 — Move balance to the user's own wallet

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/014-withdrawals.sql`, `backend/src/balance/{movements,movement-routes}.js`, `backend/test/withdrawals.test.js`; edited `backend/src/balance/service.js` (`referenceId` on credit and debit), `backend/src/custody/service.js` (user-owned custody entries: `userBacking`, `recordUserIn`, `recordUserOut`), `backend/src/app.js` (`/api/deposits`, `/api/withdrawals`), `backend/src/payments/poller.js` (resumes pending deposits and withdrawals)

**Decision taken with the user:** withdrawals are limited to balance backed in custody. The app balance only came from Rapyd recharges, which never reach custody, so it could not back a transfer. Backing for a user's balance comes from deposits.

**Choices made in this step:**
- The migration is 014, because 013 is splits.
- Added **deposits** (not in the prompt, but needed to back a balance): the user moves money from their wallet to custody; on completion the balance is credited and a custody entry for that user is recorded. Without deposits, the backed balance would always be zero.
- The custody ledger gets a third owner, `user_id`. Each entry belongs to exactly one of payment, pool or user. The out-within-in trigger checks per owner.
- A withdrawable amount is the lower of the app balance and the user's backed amount, less withdrawals in progress. The check and the reservation are in one synchronous transaction, so two requests cannot both pass.
- The balance is debited only when the withdrawal transfer completes. Nothing is debited on a pending or failed transfer.
- A withdrawal's and a deposit's balance entries use a new `ledger_entries.reference_id` column. It has no foreign key, because it does not point to a payment.
- Every response carries the notice that this is test money and cannot become cash.
- `GET /api/withdrawals/available?currency=` shows the amount withdrawable now.

**Not verified yet:**
- The balance debit and the custody out entry run in one transaction after the transfer completes. If the debit were refused there, the money would already have left custody. The reservation should make that impossible; this has not been tested against the real network.
- Deposits and withdrawals on the real test network (manual check).

## Prompt

## Prompt

A user with money held for them (received payments that they have not moved yet, or a balance from earlier steps) moves it to their own linked test wallet. This is the "withdraw" action. It does not convert money to cash.

Context: read prompts 19, 21, 23 and `backend/src/balance/`.

Steps:
1. A user's available amount is their app balance (the existing ledger), in the wallet's currency.
2. `POST /api/withdrawals` takes an amount and a linked wallet of the user's own. The app checks the balance, then runs a transfer from custody to that wallet (prompt 21).
3. The app balance is debited only when the transfer completes. A failed transfer leaves the balance unchanged.
4. The withdrawal is listed in the user's history with its status.

Constraints:
- A user can only withdraw to a wallet they have linked and that is not revoked.
- The withdrawal cannot exceed the balance; it is refused before any transfer.
- The app says plainly that the money stays in the test network and cannot become cash.
- Everything in English. No commits.

Done when:
- Tests: a successful withdrawal debits the balance once, after the transfer completes.
- Tests: a failed transfer leaves the balance unchanged.
- Tests: a withdrawal above the balance is refused before any call.

**Depends on:** prompts 19, 21, 23.

At the end, list every file changed and the result of each check.
