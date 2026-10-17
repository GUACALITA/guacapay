# 27 — One payment to several recipients

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
