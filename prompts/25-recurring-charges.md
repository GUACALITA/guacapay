# 25 — Subscriptions and recurring charges

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending. The interval format is **not verified** against the specification (see `docs/OPEN_PAYMENTS.md`).
**Files produced:** `backend/migrations/011-subscriptions.sql`, `backend/src/subscriptions/{service,routes,job}.js`, `backend/test/subscriptions.test.js`; edited `backend/src/transfers/engine.js` (`grantId`: a transfer can use a given permission), `backend/src/app.js` (`/api/subscriptions`), `backend/src/server.js` (hourly job), `docs/OPEN_PAYMENTS.md`

**Choices made in this step:**
- The migration is 011, because 010 is requests.
- The intervals are limited to `P1D`, `P1W` and `P1M`. Monthly steps keep the day of the month, or the last day of a shorter month.
- The offer link token is stored only as a hash, and it travels in the query string or body, not the path (request paths are logged).
- Each charge is one row per `(subscription, period)`, unique by constraint. A failed period is retried on the next run, using the same row and a new transfer.
- Three consecutive failures pause the subscription. A success resets the count.
- The payer's permission is used by id, so a charge never picks up their other permissions.
- The payee has no route to change the amount or interval. Changing either means a new offer and a new approval.
- A cancelled subscription's pending transfer is marked failed, so the transfer runner does not pick it up again. If the engine is in the middle of that transfer, its final write may overwrite this mark.

**Not verified yet:**
- The `interval` format in the permission (see `docs/OPEN_PAYMENTS.md`).
- Cancelling does not revoke the permission at the wallet's authorisation server. Only the local grant is revoked, and the stored token is removed. Remote revocation is not built.
- A real charge between two test wallets (manual check).

## Prompt

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
