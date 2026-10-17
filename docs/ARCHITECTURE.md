# Architecture

Written for: engineers who will change the code. Read `DECISIONS.md` for the reasons behind each choice.

**Scope (decision 017):** all money moves between Interledger test wallets through Open Payments, in play money. Nothing converts money to cash. The Rapyd gateway is kept in the repository and is not on the money path; it runs only when `PAYMENT_RAILS=rapyd`, for development.

**Verification status:** the code for every flow below is written. The automated tests for prompts 17 to 32 are written and **have not been run**. No transfer has been made on the real test network yet (see `E2E_RUN.md`). Each section says what is not verified.

## Services

| Service | Where it runs | Port | Role |
|---|---|---|---|
| `app` | Docker container, Node 20, user `node` | 3202 (published on the host) | Sign-in, wallets, consent, payments, claims, transfers, custody, requests, subscriptions, pools, splits, deposits and withdrawals, the live-status WebSocket, email, the browser pages, and the background jobs. Owns the database. |
| `gateway` | Docker container, Node 20, user `node` | 3203 (published on `127.0.0.1` only) | Talks to Rapyd. Used only when `PAYMENT_RAILS=rapyd`. |
| `mailcatcher` | Docker container (Mailpit) | SMTP 1025 (inside the network), web 8026 (host) | Receives every email in development. |
| `app_data` | Docker named volume | — | Holds the SQLite database at `/app/data/guacapay.db`. |

Background work inside `app`:

| Job | Interval | What it does |
|---|---|---|
| Payment poller (`payments/poller.js`) | every 60 seconds | Checks card payments, resumes pay-in and payout transfers still pending, resumes request transfers and deposits and withdrawals, refreshes split status, issues missing claim links. |
| Subscription job (`subscriptions/job.js`) | every hour | Activates subscriptions whose permission is granted, and charges each due period once. |
| Pool job (`pools/job.js`) | every hour | Closes collections past their date, retries failed payouts, finishes pending ones. |

## Outside services

| Service | Used for | Reached through |
|---|---|---|
| Interledger test network (`ilp.interledger-test.dev`, `auth.interledger-test.dev`) | Wallet documents, consent, quotes, incoming and outgoing payments | the app's `providers/openpayments.js` only; every host is checked against `OPEN_PAYMENTS_HOSTS` first (decision 021) |
| Rapyd (sandbox or production) | Card checkout, development only (`PAYMENT_RAILS=rapyd`) | the gateway only |
| SMTP server | Sending email | the app's `email` module (nodemailer) |

## The one module that talks to Open Payments

`backend/src/providers/openpayments.js` is the only file that imports `@interledger/open-payments`. Every call goes through it, and each call first checks the host (decision 021). It holds:

- wallet reads (public, no credentials);
- consent: `startGrant` (interactive) and `continueGrant` (after the wallet sends the user back);
- non-interactive grants for quotes and incoming payments;
- incoming payments, quotes, outgoing payments, and reading an outgoing payment's state.

Errors are mapped to app codes (`wallet_not_found`, `openpayments_rejected`, `openpayments_unavailable`). The SDK's messages go to the log, never to the caller.

## Layers inside the app

| Folder | Responsibility | Rule |
|---|---|---|
| `backend/src/config.js` | Reads environment variables | The only file that reads `process.env` in the app. |
| `backend/src/db.js`, `migrate.js` | Opens the database; applies `backend/migrations/*.sql` | Migrations run at startup, in order, once each. |
| `backend/src/auth/` | Sign-in codes, JWT, middleware | Codes and tokens are stored only as HMACs. |
| `backend/src/providers/openpayments.js` | The Open Payments client | The only file that imports the SDK. Host check first. |
| `backend/src/wallets/` | A user's wallet addresses | One active owner per address. Only `https` addresses on allowed hosts. |
| `backend/src/grants/` | Consent: create, finish, use, revoke | Tokens are encrypted at rest (`seal.js`). |
| `backend/src/transfers/` | The transfer engine (legs) and the payment-level money moves | Every leg is stored before its call. Engine never changes a payment; `payments.js` does. |
| `backend/src/payments/` | Payment states, transitions, checkout (card), reconciliation, poller | The only place that moves a payment's state. Every change writes an event. |
| `backend/src/claims/` | Claim links, recipient checks, the payout step | One payout per claim, enforced in the database. |
| `backend/src/custody/` | The custody ledger and its checks | Out entries never exceed in entries for the same owner (trigger and service). |
| `backend/src/balance/` | App balance, deposits, withdrawals | Withdrawals only up to what custody backs (decision 020). |
| `backend/src/requests/` | Payment requests and their QR codes | The request token is kept as a hash and never in a path. |
| `backend/src/subscriptions/` | Offers, consent, scheduled charges | One charge per period; three failures pause. |
| `backend/src/pools/` | Collections and tandas | Payout equals the contributions recorded for the period. |
| `backend/src/splits/` | One payment to several recipients | Parts are checked before anything is created. |
| `backend/src/email/` | Templates and sending | Logs never contain codes, links or addresses. |
| `backend/src/ws/` | Live status over WebSocket | Sends only payments the signed-in owner may see. |
| `backend/src/gateway-client.js` | HTTP client for the gateway | Used only on the card rail. |
| `frontend/` | Plain HTML pages and one API client | No `innerHTML`; session token in `sessionStorage`. |
| `gateway/src/providers/rapyd.js` | Rapyd field names, signing, webhook checks | The only file that knows Rapyd's format. |

## The money path: pay by email

This is the product's main flow. It is built; it is **not yet verified on the real test network**.

1. **Link a wallet (once).** The user adds the wallet's address (`POST /api/wallets`). The app reads the public wallet document. The wallet stays `pending` until consent is approved. Creating the wallet is the person's own job, on the official site (`wallet-setup.html`).

2. **Consent (once per wallet).** `POST /api/grants` asks the wallet's authorization server for a permission. The wallet opens its own approval page. When the user returns, `GET /api/grants/callback` checks the nonce and finishes the grant, then the wallet is `linked`. A grant can be finished once; a repeat is refused (`grant_not_pending`).

3. **Create the payment.** `POST /api/payments` with an `Idempotency-Key`. The payment is `created`.

4. **Transfer 1: sender wallet to custody.** `POST /api/payments/:id/pay-with-wallet` with the wallet to pay from. `payFromWallet` (`transfers/payments.js`) moves the payment to `awaiting_payment` and creates a transfer with direction `in`. The engine runs it (below). When it completes, the payment becomes `paid`, the custody ledger records an `in` entry for the payment, and the claim link is issued. If transfer 1 fails for good, the payment becomes `failed`.

5. **Claim.** The recipient gets the link by email. `POST /api/claims/verify-email` sends a code to the recipient's address. `POST /api/claims/confirm` checks the code and a wallet address on an allowed host, then runs the payout. The custody ledger must hold the payment's amount before the code is used (`assertCustodyHolds`).

6. **Transfer 2: custody to recipient.** The claim moves to `claiming`, so no second request can start a payout. The payout is a transfer with direction `out` from the custody wallet. When it completes, the custody ledger records an `out` entry, the claim becomes `claimed`, the payment goes `claimable` → `claimed` → `completed`, and the sender is emailed. If it fails for good, the payment becomes `failed` and the money stays in custody. If it is still running, the claim stays `claiming`, and the poller finishes it later.

The engine behind both transfers is described next.

### The transfer engine (legs)

`transfers/engine.js` moves money between two wallets in three legs, each one an Open Payments object with its own state:

1. **Incoming payment** at the receiver (non-interactive grant for the receiver).
2. **Quote** at the sender (non-interactive grant for the sender), priced to the incoming payment.
3. **Outgoing payment** at the sender, using the sender's permission, then read until the network reports `COMPLETED` or `FAILED`.

Every leg is stored before its call, so a retry reuses it and never creates a second outgoing payment. If a retry finds an outgoing leg with no answer, the transfer stays `pending` with `outgoing_state_unknown`. Failures split into two kinds:

- **Definitive** (asset mismatch, failed payment, rejected request): the transfer becomes `failed`.
- **Retryable** (no permission, expired permission, network down, timeout): the transfer stays `pending` with the reason, and the poller tries again.

Both wallets must hold the transfer's currency at scale 2 (`asset_mismatch` otherwise). A transfer made for a subscription uses that subscription's permission by id (`grant_id`), so a charge never picks up another permission.

**Not verified:** the exact state names the network returns for an outgoing payment (the code compares upper-case `COMPLETED` and `FAILED`), and whether the receiver's incoming-payment permission is granted without interaction. Both are open items in `OPEN_PAYMENTS.md`.

## Custody

The custody wallet is one platform test wallet, configured with `CUSTODY_WALLET_ID` and `CUSTODY_WALLET_ADDRESS`. At startup the app checks that it exists, is linked, and has a permission (`checkCustodyWallet`); a failed check is logged, and the rest of the app keeps running.

The custody ledger (`custody_entries`) records every amount that enters or leaves custody. Each entry belongs to exactly one owner:

| Owner | Written when |
|---|---|
| a payment | pay-in completes (`in`); payout completes (`out`) |
| a pool | a member's contribution completes (`in`); a pool payout completes (`out`) |
| a user | a deposit completes (`in`); a withdrawal completes (`out`) |

A database trigger refuses any `out` entry larger than the `in` entries for the same owner. The service checks the same rule before a payout starts. `custodyBalances()` sums the ledger per currency and throws if any balance is negative. The operator endpoint `GET /api/custody` shows these with the gateway token only.

**Not verified:** reconciliation with the custody wallet's own balance. The test network's wallet documents show no balance field this app reads, so the report says `not_available_from_api`.

## Grant lifecycle

| State | Meaning | How it changes |
|---|---|---|
| `pending` | Asked; the user has not approved yet | Created by `requestConsent`; becomes `granted` on a successful callback, or immediately if the wallet grants without interaction |
| `granted` | Usable: its access token is stored, encrypted | Finished by `finishConsent` (one time only) |
| `expired` | Its token's lifetime has passed | Set when a transfer finds it expired; the next use is refused (`grant_expired`) |
| `revoked` | Revoked by the owner, or because its wallet was revoked or its subscription or pool was cancelled | Clears both stored tokens. **Local only:** the wallet's authorization server is not told (open item F11). |

Tokens are encrypted with AES-256-GCM (`grants/seal.js`), keyed by `GRANT_ENCRYPTION_KEY`. Consent links carry a random nonce, stored only as a hash.

## Payment states

```
created -> awaiting_payment -> paid -> claimable -> claimed -> completed
               |                                       |
               +-> expired                             +-> failed
               +-> failed
created -> failed
claimable -> expired
```

`completed`, `expired` and `failed` have no further moves. The table is in `backend/src/payments/states.js`. A payment's `payment_method` is `wallet` (the product path), `balance` (app balance, internal), or `rapyd` (card, development).

## Other flows

| Flow | Where | State | Verified |
|---|---|---|---|
| Payment request: one transfer from the payer's wallet to the requester's wallet, no custody or claim | `requests/service.js` | Written, tested offline (`requests.test.js`) | No |
| Subscription: offer, approval once with a limit equal to one period, one charge per period, three failures pause, cancel revokes the permission | `subscriptions/service.js` | Written, tested offline (`subscriptions.test.js`) | No. Interval format unverified (`OPEN_PAYMENTS.md`). |
| Group pool: collection (goal or closing date) and tanda (every member pays, then one member is paid) | `pools/service.js` | Written, tested offline (`pools.test.js`) | No |
| Split: one payment to 2 to 20 recipients, each part a child payment with its own claim | `splits/service.js` | Written, tested offline (`splits.test.js`) | No |
| Deposit (wallet to custody, credits the balance) and withdrawal (custody to own wallet, backed balance only) | `balance/movements.js` | Written, tested offline (`withdrawals.test.js`) | No |
| Live status over WebSocket | `ws/live-status.js` | Tested offline (`live-status.test.js`) | Not on the test network |
| Dashboard (wallet, money, requests, subscriptions, pools, history) | `frontend/dashboard.html` | Written; static checks (`frontend-dashboard.test.js`) | No: empty-account load and 360 px layout not checked in a browser |

## Card path (development only)

Used only when `PAYMENT_RAILS=rapyd`. The sender pays a Rapyd checkout; Rapyd's webhook reaches the gateway, which checks its signature and forwards the event to the app. The app asks the gateway for the checkout status before it marks a payment `paid`. A card payment never enters custody, so its claim cannot be paid out (the ledger refuses it). Recharges of the app balance use the same rail and are not withdrawable (decision 020).

The card path is kept for development. It is not the product's money path (decision 017).

## Failure behavior

| Failure | What happens |
|---|---|
| The network is down during a transfer | The transfer stays `pending`; the poller or the next request retries it. Nothing is marked failed. |
| An outgoing payment reports `FAILED` | The transfer is `failed`. For a payment, the payment is `failed`; for a payout, the money stays in custody. |
| A retry finds an outgoing payment without an answer | The transfer waits with `outgoing_state_unknown`; no second payment is sent. |
| The custody wallet is not configured | Pay-in, payout, deposits and withdrawals return 503 `transfer_not_configured`. The claim reopens. |
| A payout exceeds what custody holds | Refused before any money moves (`custody_out_exceeds_in`). |
| A split part cannot be paid | That part is marked failed; the others continue. |
| A request is paid twice | The second attempt gets `request_already_paid`. |
| A charge for a period is repeated | The unique key prevents it; the job skips the period. |
| Email cannot be sent | Sign-in returns 503 `email_failed`. A claim link is not saved; the poller tries again. |
| The app restarts | Migrations run again and change nothing. Rate-limit counters are lost. Pending transfers resume on the next poller run. |

## Limits of this design

- **One app instance.** Live updates use an in-process event emitter, the IP rate limit is in memory, and background jobs assume one process (`DECISIONS.md`, 005 and 010).
- **SQLite.** Fine for one instance and the testnet stage (`DECISIONS.md`, 001).
- **Not built:** remote revocation of permissions (F11); screens for deposit, withdrawal, split, subscription creation, pool creation and joining; the payer's pages for requests, subscription offers and pool joins.
- **Not verified:** every flow above on the real test network; the webhook encoding for the card path (`DECISIONS.md`, 008).
