# 28 — Move balance to the user's own wallet

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
