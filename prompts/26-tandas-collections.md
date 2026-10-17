# 26 — Group pools: tandas and collections

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/012-pools.sql`, `backend/src/pools/{service,routes,job}.js`, `backend/test/pools.test.js`; edited `backend/src/custody/service.js` (entries belong to a payment or a pool), `backend/src/app.js` (`/api/pools`), `backend/src/server.js` (hourly job)

**Choices made in this step:**
- The migration is 012, because 011 is subscriptions.
- Custody entries can belong to a pool, not only to a payment. The table is rebuilt in migration 012 (nothing references it), and the out-within-in trigger now checks per payment or per pool.
- Beyond the listed columns, added: `pools.organizer_wallet_id` (where the payout goes), `pools.closes_at` (the collection closing date), `pools.period_due_at` (for "late"), `pools.current_period`, `pool_members.grant_id` (each member's permission), and a `pool_payouts` table (one payout per pool period, unique).
- The pool status adds `closing`: while a payout is in progress, no contribution is accepted, so the amount cannot change under it.
- A payout's amount is recomputed from the completed contributions each time it starts, so a retry never pays a stale total.
- A failed payout returns the pool to `active`, and the hourly job retries it. A payout left pending (for example, after a restart) is resumed by the same job.
- Collection consent uses purpose `link` with a limit of one share; tanda consent uses `recurring` with the pool's period.
- Late = no completed contribution for the current period, and the due date has passed. Late members are shown to the organizer and members; nothing is sent to them.

**Not verified yet:**
- The `interval` format of tanda consents (see `docs/OPEN_PAYMENTS.md`, not verified).
- A real payout between two test wallets (manual check).
- A collection that closes by date with money below the goal pays the partial total to the organizer. This is what the prompt says; confirm it is wanted.

## Prompt

## Prompt

A group pool collects money from several people into one goal, then pays the organizer. Two kinds:
- **Collection:** everyone pays a share toward one goal (for example, a gift or a trip). When the goal is reached or the date passes, the total goes to the organizer.
- **Tanda:** a rotating savings circle. Each period, every member pays the same amount into the pool, and the whole pool goes to one member, in a fixed order.

Context: read prompts 22, 23 and 21. The pool's money sits in the custody wallet (prompt 23), recorded per pool.

Steps:
1. Migration `backend/migrations/011-pools.sql`: tables `pools` (`id`, `organizer_user_id`, `kind` = `collection` | `tanda`, `goal_cents`, `share_cents`, `currency`, `period`, `order_json`, `status`, `created_at`), `pool_members` (`pool_id`, `user_id`, `wallet_id`, `position`, `joined_at`), and `pool_contributions` (`id`, `pool_id`, `user_id`, `period`, `amount_cents`, `transfer_id`, `status`).
2. Members join by link. Each member links a wallet (prompt 19) and gives consent for their share (prompt 20).
3. Collection: each member's contribution is a transfer to custody, recorded in the pool. When the total reaches the goal, or the closing date passes, a payout transfer from custody to the organizer's wallet is made.
4. Tanda: each period, the contributions are collected. When every member has paid for the period, the pool payout goes to the member at that position, and the period advances.
5. A member who misses a contribution is shown as late. The pool does not pay out without every contribution for that period (tanda).

Constraints:
- A member cannot contribute twice for the same period.
- The payout total always equals the contributions recorded for that pool.
- Everything in English. No commits.

Done when:
- Tests: a collection reaches its goal and pays the organizer exactly the total.
- Tests: a tanda does not pay out until every member has paid for the period.
- Tests: a double contribution for one period is refused.

**Depends on:** prompts 19 to 23.

At the end, list every file changed and the result of each check.
