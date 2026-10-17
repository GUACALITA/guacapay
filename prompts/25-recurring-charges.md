# 25 — Subscriptions and recurring charges

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

A business or person sets up a recurring charge on a subscriber. The subscriber approves it once, with a limit and an interval. Each period, the app makes the transfer, without asking the subscriber again.

Context: read prompts 20 and 21. Open Payments grants accept an `interval` in their debit limit (ISO 8601 repeating interval, for example monthly). Verify the exact format against the current documentation before coding it, and record the source in `docs/OPEN_PAYMENTS.md`.

Steps:
1. Migration `backend/migrations/010-subscriptions.sql`: table `subscriptions` (`id`, `payer_wallet_id`, `payee_wallet_id`, `amount_cents`, `currency`, `interval`, `grant_id`, `status` = `pending` | `active` | `paused` | `cancelled`, `next_charge_at`, `created_at`) and `subscription_charges` (`id`, `subscription_id`, `period_start`, `transfer_id`, `status`, `created_at`).
2. The payee creates a subscription offer. The payer opens it, sees the amount and interval, and gives consent (prompt 20) with a limit equal to one period's amount.
3. A scheduled job (once an hour) finds active subscriptions whose `next_charge_at` has passed. For each, it creates one charge per period, unique per `(subscription_id, period_start)`, and runs the transfer (prompt 21).
4. A failed charge is recorded and retried at the next run; after three failures the subscription is `paused`.
5. The payer can cancel at any time. Cancelling revokes the grant.

Constraints:
- One charge per period, even if the job runs twice (enforced by the unique key).
- The payee cannot raise the amount without a new consent.
- Everything in English. No commits.

Done when:
- Tests: a subscription charges once per period, and a repeated job run charges nothing extra.
- Tests: three failed charges pause the subscription.
- Tests: cancelling revokes the grant and stops charges.
- Manual check (reported): one period charged between two real test wallets.

**Depends on:** prompts 19, 20, 21.

At the end, list every file changed and the result of each check.
