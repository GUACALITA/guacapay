# 27 — One payment to several recipients

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/013-splits.sql`, `backend/src/splits/{service,routes}.js`, `backend/test/splits.test.js`; edited `backend/src/payments/service.js` (`parentSplitId` in `createPayment`), `backend/src/app.js` (`/api/splits`), `backend/src/payments/poller.js` (refreshes pending splits)

**Choices made in this step:**
- The migration is 013, because 012 is pools.
- Split status is `pending` while any child is still in progress, `completed` when every child completed, and `partial` when all are finished and at least one failed or expired.
- Every part is validated before anything is written: count (2 to 20), duplicate recipients, each amount, and the sum. A failed check creates no split and no child.
- The split and its children are created in one transaction. Each part is then paid in turn. A part that cannot be paid is marked `failed` with a reason; the others still run.
- A `split_payments.idempotency_key` (optional header, unique per payer) returns the first split for a repeated request. A repeated key with different details is refused with `idempotency_conflict`. This is not in the prompt; it stops a retried request from paying twice.
- Each part uses the payer's permission. Its limit must cover the part; this is not checked here.

**Not verified yet:**
- The payer's permission limit against the sum of several parts. A payer whose permission covers one part may have later parts refused by the network. Those parts show as failed; the others are unaffected.
- A real split between two test wallets (manual check).

## Prompt

## Prompt

A payer sends one amount that is split among several recipients: for example, a shared bill or a group purchase. Each recipient gets their part by email, through the existing claim flow.

Context: read prompts 21 and 22. A split is one payment with several child payments, each with its own claim.

Steps:
1. Migration `backend/migrations/012-splits.sql`: table `split_payments` (`id`, `payer_user_id`, `total_cents`, `currency`, `status`, `created_at`) and add `parent_split_id` to `payments` (nullable).
2. `POST /api/splits` takes a total and a list of `{recipient_email, amount_cents}`. The amounts must add up exactly to the total. Refuse otherwise (`split_mismatch`).
3. Each part becomes a child payment, paid from the payer's wallet to custody in one transfer per part (prompt 22), then claimed separately.
4. The split is `completed` when every child payment is `completed`. Any child can fail without affecting the others; the split shows which failed.

Constraints:
- No child payment is created if the parts do not add up to the total.
- A split is limited to 20 recipients.
- Everything in English. No commits.

Done when:
- Tests: parts that add up create one child per recipient.
- Tests: parts that do not add up are refused, and nothing is created.
- Tests: one failed child leaves the others unaffected, and the split reports it.

**Depends on:** prompt 22.

At the end, list every file changed and the result of each check.
