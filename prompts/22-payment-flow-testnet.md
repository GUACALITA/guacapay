# 22 — Pay by email: sender to custody, claim, custody to recipient

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Implement the main product flow on test wallets: a sender pays an email address, the money is held in the platform's custody wallet, and the recipient claims it to their own wallet.

Context: read prompts 19 to 21, the existing `backend/src/payments/` and `backend/src/claims/` code, and `docs/DECISIONS.md` (decisions 006, 012, 017).

Flow:
1. The sender is signed in and has a linked wallet with consent (prompts 19 and 20).
2. The sender creates a payment to an email address and chooses "Pay from my wallet".
3. Transfer 1 (prompt 21): sender wallet to the **custody wallet**. The payment is `paid` only when this transfer completes.
4. The claim link is emailed to the recipient (existing claim code). The payment is `claimable`.
5. The recipient confirms with the email code and a wallet address they own (prompt 19 link rules apply to them too).
6. Transfer 2 (prompt 21): custody wallet to the recipient's wallet. The claim moves to `claimed`, then the payment to `completed` when transfer 2 completes.
7. If transfer 2 fails, the payment becomes `failed`, the money stays in custody, and the failure is recorded. A later retry is allowed by the platform.

Steps:
1. Add a `payment_method` field to payments: `wallet` (new) or `balance` (existing app balance, kept for internal use).
2. Replace the claim transfer step (prompt 12) with the two-transfer flow above.
3. Remove the Rapyd checkout from the wallet path. The payment page offers "Pay from my wallet" only.
4. Record both transfers in the payment's event log with their legs.

Constraints:
- No money is shown as completed before Open Payments reports it so.
- Every transition still goes through the state table (decision 006).
- Tests use the fake Open Payments server for both transfers, including a failed second transfer.
- Everything in English. No commits.

Done when:
- In tests: a full run (pay, custody, claim, payout) ends in `completed`, with two transfers recorded.
- In tests: a failed second transfer ends in `failed` and the custody balance still shows the money.
- A payment cannot reach `paid` without a completed first transfer.
- Manual check (reported): the same run on the real test network with two linked wallets.

**Depends on:** prompts 19, 20, 21, 23, and two real test wallets with approved consent.

At the end, list every file changed and the result of each check.
