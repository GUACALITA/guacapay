# 21 — Transfer engine: quote, incoming, outgoing, confirmation

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/007-transfers.sql`, `backend/src/transfers/engine.js`, `backend/test/transfers.test.js`; edited `backend/src/providers/openpayments.js` (`requestNonInteractiveGrant`, `createIncomingPayment`, `createQuote`, `createOutgoingPayment`, `getOutgoingPayment`)

**Choices made in this step:**
- The outgoing leg is stored before its call, with no remote ID. If a retry finds that leg without an answer, the transfer stays pending with `outgoing_state_unknown`, and nobody sends a second payment by accident.
- The incoming and quote legs are stored after their calls. They move no money, so a repeat only creates an extra incoming payment or quote.
- A timeout while waiting for the outgoing payment leaves the transfer `pending` with `leg_timeout`. It is never marked failed, because the money may still complete.
- Definitive refusals (asset mismatch, failed payment, rejected request) mark the transfer `failed`. Fixable problems (no permission, expired permission, network down) leave it `pending` with the reason.
- The engine does not change payments. The caller decides what a completed transfer means.

**Not verified yet:**
- That the receiver's incoming-payment permission is granted without interaction on the real network. This was taken from the reference implementation's behavior, not yet confirmed. If the test network asks for approval, the engine refuses with `receiver_interaction_required`.
- The field names of the outgoing payment's `state` on the real network (the code compares them in upper case: COMPLETED, FAILED).
- A real transfer between two test wallets (prompt 31).

## Prompt

Build the one routine that moves money between two test wallets. Every payment in the product uses it: pay by email, claim, withdrawal, recurring charge, pool payout.

Context: read prompts 18 and 20. The steps follow the Open Payments guide (fixed-debit remittance): an incoming payment at the receiver, a quote at the sender, then an outgoing payment at the sender.

A transfer is made of **legs**. Each leg is one Open Payments object and has its own state.

Steps:
1. Migration `backend/migrations/007-transfers.sql`: table `transfers` (`id`, `payment_id`, `from_wallet_id`, `to_wallet_id`, `amount_cents`, `currency`, `status`, `failure_code`, `created_at`, `updated_at`) and table `transfer_legs` (`id`, `transfer_id`, `kind` = `incoming` | `quote` | `outgoing`, `remote_id`, `status`, `created_at`, `updated_at`).
2. `backend/src/transfers/engine.js`, function `runTransfer(transferId)`:
   - Read the receiver wallet (public document), create an incoming payment with a `read`/`create` grant for the receiver (non-interactive, to be verified first).
   - Create a quote with the sender's `quote` grant (prompt 20).
   - Create the outgoing payment with the sender's `outgoing-payment` grant, using the quote.
   - Read the outgoing payment until it reports completed, with a timeout.
3. Idempotency: each leg is stored before the call and reused on retry, so a repeated run never creates a second outgoing payment.
4. Amounts are integers in the wallet's asset scale, converted once and stored. A currency that does not match the wallet asset is refused before any call (`asset_mismatch`).
5. The engine never marks the payment completed by itself. It returns the transfer status; the payment logic in prompt 22 reads it.

Constraints:
- Tests use the fake Open Payments server: success, a leg that stays pending until timeout, a rejected quote, and a repeated run.
- Everything in English. No commits.

Done when:
- A full transfer succeeds against the fake server, and each leg is stored.
- Running the same transfer twice creates one outgoing payment.
- An asset mismatch is refused without any remote call.
- Manual check (reported): one real transfer between two test wallets, with the outgoing payment state read back as completed.

**Depends on:** two linked test wallets and approved consent (prompts 19 and 20). The receiver's incoming-payment grant behavior must be verified on the real network first.

At the end, list every file changed and the result of each check.
