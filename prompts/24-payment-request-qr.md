# 24 — Payment requests and QR codes

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/010-requests.sql`, `backend/src/requests/{service,qr,routes}.js`, `backend/test/requests.test.js`; edited `backend/src/transfers/engine.js` (`requestId`), `backend/src/payments/poller.js` (`resumeRequests`), `backend/src/app.js` (`/api/requests`), `backend/package.json` and `backend/package-lock.json` (`qrcode` 1.5.4; dev: `jsqr` 1.4.0, `pngjs` 7.0.0)

**Choices made in this step:**
- The migration is 010, because 009 is the custody ledger.
- The request payment is a direct transfer from the payer's wallet to the requester's wallet. It has no custody step and no claim. It is recorded as a transfer with `request_id` set and `payment_id` NULL, not as a `payments` row: the payment states have no path to `completed` without a claim.
- Request transfers use direction `in`, because the transfer table allows only `in` and `out`. This is a naming compromise: `in` is not custody for these rows.
- The token is not in the path: `GET /api/requests/public?token=` and `POST /api/requests/public/pay` (token in body). Request paths are written to the log, so a token in the path would leak into it.
- The QR is returned once, in the creation response, to the owner. The token is stored only as a keyed hash, so the link and its QR cannot be produced again later.
- A failed payment clears the claim on the request, so another payer can try. A pending payment blocks other payers until it ends.
- `users.first_name` is added and returned as `owner_first_name`. Nothing sets it yet, so it is null until a profile exists.

**Not verified yet:**
- The `qrcode` package is pinned but not run. The lockfile was regenerated in a Node container without touching `node_modules`.
- No frontend page was written; the prompt's steps do not list one.
- Real payment between two test wallets (manual check).

## Prompt

## Prompt

A user asks to be paid: they create a payment request with an amount and a note, and share it as a link or a QR code. The payer opens it and pays from their linked test wallet.

Context: read prompts 19 to 22. A payment request is a payment whose recipient is already known (the requester's wallet), so it skips the claim step.

Steps:
1. Migration `backend/migrations/009-requests.sql`: table `payment_requests` (`id`, `owner_user_id`, `wallet_id`, `amount_cents`, `currency`, `note`, `status` = `open` | `paid` | `closed`, `expires_at`, `created_at`) with a random public token stored only as a hash.
2. Routes: `POST /api/requests` (owner), `GET /api/requests` (owner), `GET /api/requests/public/:token` (anyone with the link: shows amount, note and the owner's first name only), `POST /api/requests/public/:token/pay` (payer must be signed in and have a linked wallet).
3. The payer's payment is a transfer from their wallet to the requester's wallet (prompt 21), recorded as a normal payment.
4. QR: the request link is encoded as a QR code image on the server (the `qrcode` package, already in the reference stack; add it here with a version pinned). The image is served only to the owner.
5. A request is `paid` only when its transfer completes, and it cannot be paid twice.

Constraints:
- The public page shows no wallet URL, email or internal ID.
- A request expires; expired requests cannot be paid.
- Everything in English. No commits.

Done when:
- Tests: create, view publicly, pay, and the request becomes `paid` after the transfer completes.
- Tests: a second payment to a paid request is refused.
- Tests: an expired request cannot be paid.
- The QR image decodes back to the request link (checked in a test).

**Depends on:** prompts 19, 20, 21.

At the end, list every file changed and the result of each check.
