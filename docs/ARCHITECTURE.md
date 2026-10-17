# Architecture

Written for: engineers who will change the code. Read `DECISIONS.md` for the reasons behind each choice.

**Scope (decision 017):** all money moves between Interledger test wallets through Open Payments. The Rapyd gateway is kept but is not on the money path; it runs only when `PAYMENT_RAILS=rapyd`. The step-by-step flow below describes the earlier card-collection design and is being replaced by the two-transfer flow in `prompts/22-payment-flow-testnet.md`.

## Services

| Service | Where it runs | Port | Role |
|---|---|---|---|
| `app` | Docker container, Node 20, user `node` | 3202 (published on the host) | Sign-in, payments, claims, the WebSocket for live status, email, the browser pages, and the poller. Owns the database. |
| `gateway` | Docker container, Node 20, user `node` | 3203 (published on `127.0.0.1` only) | The only service that talks to Rapyd. Verifies Rapyd webhooks and forwards events to the app. |
| `mailcatcher` | Docker container (Mailpit) | SMTP 1025 (inside the network), web 8026 (host) | Receives every email in development. |
| `app_data` | Docker named volume | — | Holds the SQLite database file at `/app/data/guacapay.db`. |

Inside the Docker network the app reaches the gateway at `http://gateway:3203`, and the gateway reaches the app at `http://app:3202`.

## Outside services

| Service | Used for | Reached through |
|---|---|---|
| Rapyd (sandbox `sandboxapi.rapyd.net`, production `api.rapyd.net`) | Card collection: checkouts and their status | the gateway only |
| Interledger test network (`ilp.interledger-test.dev`) | The transfer leg (Open Payments). Not built yet. | the app's `openpayments` module, when it exists |
| SMTP server | Sending email | the app's `email` module (nodemailer) |

## Diagram

```
                        Browser (pages in frontend/)
                          |                 ^
           HTTP JSON      |                 | WebSocket /ws (live status)
                          v                 |
   +-------------------------------------------------------------+
   | app  (port 3202)                                            |
   |   auth      payments      claims      live status           |
   |   email     poller        /internal/payment-events          |
   |                    |                                        |
   |                 SQLite (app_data volume)                    |
   +-------|-------------------------------------|---------------+
           | HTTP + GATEWAY_TOKEN                | SMTP
           v                                     v
   +--------------------------+          +-------------------+
   | gateway  (port 3203)     |          | mailcatcher       |
   |   /checkout              |          | (development)     |
   |   /checkout/status/:id   |          +-------------------+
   |   /webhooks/rapyd  <-----|----------- Rapyd (webhooks)
   +-----------|--------------+
               | signed HTTP (Rapyd signature)
               v
          Rapyd API (sandbox or production)
```

## Layers inside the app

| Folder | Responsibility | Rule |
|---|---|---|
| `backend/src/config.js` | Reads environment variables | The only file that reads `process.env` in the app. |
| `backend/src/db.js` | Opens the database | The only file that opens the database. |
| `backend/src/migrate.js` | Applies `backend/migrations/*.sql` | Runs at startup. |
| `backend/src/auth/` | Sign-in codes, JWT, middleware | Codes and tokens are stored only as HMACs. |
| `backend/src/payments/` | Payment states, transitions, checkout, reconciliation, poller | The only place that moves a payment's state. Every change writes an event. |
| `backend/src/claims/` | Claim links, recipient checks, the transfer step | One transfer per claim, enforced in the database. |
| `backend/src/email/` | Templates and sending | Logs never contain codes, links or addresses. |
| `backend/src/ws/` | Live status over WebSocket | Sends only what the signed-in owner may see. |
| `backend/src/gateway-client.js` | HTTP client for the gateway | The app never calls Rapyd directly. |
| `gateway/src/providers/rapyd.js` | Rapyd field names, signing, webhook checks | The only file that knows Rapyd's format. |

## The path of one payment

This is the normal path. Each step names the code that does it.

1. **Sign in.** The sender enters an email. `POST /api/auth/request-code` sends a 6-digit code by email (`auth/service.js`, `email/send.js`). `POST /api/auth/verify-code` returns a token that the browser keeps in `sessionStorage`.

2. **Create the payment.** `POST /api/payments` with an `Idempotency-Key` (`payments/service.js`). The payment is `created`. A repeat with the same key returns the same payment.

3. **Start the checkout.** `POST /api/payments/:id/checkout` (`payments/checkout.js`) asks the gateway for a checkout (`POST /checkout`). The gateway calls Rapyd (`providers/rapyd.js`) with a signed request, using the payment ID as the idempotency key. The app stores the checkout ID and moves the payment to `awaiting_payment`. The browser goes to Rapyd's hosted page.

4. **The payer pays on Rapyd's page.** Rapyd sends a webhook to the gateway's `/webhooks/rapyd` (`gateway/src/app.js`). The gateway checks the signature on the raw body and answers 200 at once. It then forwards `{eventId, type, paymentReference}` to the app's `/internal/payment-events`, with `GATEWAY_TOKEN`.

5. **The app confirms with Rapyd.** `payments/reconcile.js` asks the gateway for the checkout status. Only a confirmed `paid` moves the payment to `paid`. The event ID is stored, so a repeat does nothing. If the webhook never arrives, the poller (`payments/poller.js`, every 60 seconds) finds payments waiting for two minutes and does the same check.

6. **The claim link.** Once the payment is `paid`, `claims/service.js` creates a claim and emails the link `BASE_URL/claim.html?token=...`. The claim is kept only if the email is sent: if sending fails, its row is removed. The payment becomes `claimable` once the email has gone out.

7. **The recipient claims.** On `claim.html` the recipient enters their email (`POST /api/claims/verify-email`). A code is sent to that address. They enter the code and a wallet address (`POST /api/claims/confirm`). The wallet must be an `https` address on an allowed host. The code is checked after the destination, so a typo does not use it up.

8. **The payout.** The claim moves to `claiming`, so no second request can start a payout. The payout runs as transfer 2 (`transfers/payments.js`): custody wallet to the recipient's wallet. If custody is not configured, it returns 503 and the claim reopens. When the transfer completes, the claim is `claimed`, the payment goes `claimable` → `claimed` → `completed`, and the sender gets a confirmation email. If the transfer fails for good, the payment goes to `failed` and the reason is recorded; the money stays in custody. If the transfer is still running, the claim stays `claiming` and the poller settles it later.

The sender's money reaches custody first, through transfer 1 (`direction` `in`, sender wallet to custody). The payment becomes `paid` only when that transfer completes, and the claim link is then issued.

9. **Live updates.** Each change in step 4 to 8 publishes an event after its transaction commits. The browser's `payment.html` gets it over `/ws` (`ws/live-status.js`), so the status changes without a refresh.

Every change of state writes one row to `payment_events`, in the same transaction as the change.

## Payment states

```
created -> awaiting_payment -> paid -> claimable -> claimed -> completed
               |                                       |
               +-> expired                             +-> failed
               +-> failed
created -> failed
claimable -> expired
```

`completed`, `expired` and `failed` have no further moves. The table is in `backend/src/payments/states.js`.

## Failure behavior

| Failure | What happens |
|---|---|
| Rapyd is down when a checkout starts | The gateway retries network errors twice, then returns `provider_unavailable`. The payment stays `created`, and the sender can try again. |
| A webhook is lost | The poller finds the payment after two minutes and checks Rapyd directly. |
| A webhook is repeated | The event ID is already stored, so nothing changes. |
| The app cannot forward an event | The gateway retries three times and logs the event. The poller covers the payment. |
| The email cannot be sent | Sign-in returns 503 `email_failed`. A claim link is not saved, and the poller tries again. |
| The transfer is not configured | The claim stays open and the payment stays `claimable`. Nothing is marked failed. |
| The transfer fails | The payment goes to `failed` and the reason is recorded. The claim is not reopened. |
| The app restarts | Migrations run again and change nothing. Rate-limit counters held in memory are lost (see `DECISIONS.md`, 005). |

## Limits of this design

- **One app instance.** Live updates use an in-process event emitter, and the IP rate limit is in memory. Running two instances needs a shared bus and a shared store (`DECISIONS.md`, 005 and 010).
- **SQLite.** Fine for one instance and the testnet stage. A move to Postgres would need a new migration path (`DECISIONS.md`, 001).
- **Webhook encoding and replay window.** Not yet confirmed against a real webhook (`DECISIONS.md`, 008).
