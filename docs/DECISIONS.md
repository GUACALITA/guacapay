# Decisions

Each entry records a choice, its reason, and what it rules out. Numbers are stable: prompt files and `AI_USAGE.md` refer to them.

## 001 — SQLite as the database

- **Decision:** use SQLite through `better-sqlite3`, stored in a file.
- **Reason:** one service, no extra container, enough for the testnet stage. Keeps `docker compose up` simple.
- **Rules out:** Postgres and Redis for now. Add them only when a later prompt shows a need.

## 002 — Plain SQL migrations

- **Decision:** numbered `.sql` files in `backend/migrations/`, applied in order by `backend/src/migrate.js`. Each one is recorded in `schema_migrations` and runs once.
- **Reason:** no ORM to learn or maintain, and the schema is visible in one place.
- **Rule:** never edit a migration that has been applied. Add a new numbered file instead.

## 003 — Secrets at rest are hashed with HMAC-SHA256

- **Decision:** OTP codes and claim tokens are stored only as `HMAC-SHA256(HMAC_SECRET, value)`.
- **Reason:** a copy of the database alone does not reveal a valid code or token.
- **Rule:** never store a plain code or token in any table, log, or event payload.

## 004 — WAL mode and foreign keys

- **Decision:** the connection uses `journal_mode = WAL` and `foreign_keys = ON`.
- **Reason:** WAL lets readers run while a write is in progress. Foreign keys are off by default in SQLite and would silently allow broken references.

## 005 — Login with a one-time code

- **Decision:** a 6-digit code, generated with `crypto.randomInt`, valid for 10 minutes. Only its HMAC is stored. Five wrong attempts block the code. A new request replaces the pending code. A successful login returns a JWT (HS256, 1 hour, subject = user ID only).
- **Limits:** 3 code requests per address per 15 minutes (stored in the database). 10 requests per IP per 15 minutes (in memory, reset on restart; a shared limit across instances would need a store such as Redis, added only if we run more than one instance).
- **Anti-enumeration:** a valid request gets the same response whether or not the address has an account. Wrong, expired, used, and unknown codes all return the same error.
- **Email:** the code is sent through the email module (decision 013). If SMTP is not configured, the request returns 503 and no code is sent or logged.

## 006 — Payment states, transitions, and idempotency

- **Decision:** payments move through eight states (`created`, `awaiting_payment`, `paid`, `claimable`, `claimed`, `completed`, `expired`, `failed`). The allowed moves are one table in `backend/src/payments/states.js`. Any other move is rejected and writes nothing.
- **Events:** every state change writes one `payment_events` row in the same transaction as the change. Creation is recorded as a move from nothing to `created`.
- **Idempotency:** the optional `Idempotency-Key` header is unique per sender. A repeat with the same details returns the original payment (200). A repeat with different details returns 409.
- **Money:** amounts are integer cents. Limits and accepted currencies come from configuration (`PAYMENT_MIN_CENTS`, `PAYMENT_MAX_CENTS`, `PAYMENT_CURRENCIES`).
- **Visibility:** a user who does not own a payment gets the same 404 as for a payment that does not exist.

## 007 — Rapyd is reached only through the gateway

*Status: still true for the card rail (`PAYMENT_RAILS=rapyd`). Rapyd is not on the money path since decision 017.*

- **Decision:** the app never calls Rapyd. It calls the gateway over HTTP, and only the gateway's `providers/rapyd.js` knows Rapyd URLs, field names, and signing.
- **Signing:** as documented, `base64(hex(HMAC-SHA256(secret, method + path + salt + timestamp + access_key + secret + body)))`. Salt is 16 hex characters. The body is empty for GET and compact JSON for POST. Confirmed by Rapyd's sandbox accepting a checkout request.
- **Retries:** only network errors and timeouts are retried (twice). Each attempt gets a new salt and timestamp, and POST keeps the same `idempotency` header (the payment ID), so a retry cannot create a second checkout.
- **Errors:** Rapyd errors become our codes (`provider_auth_failed`, `provider_rejected`, `provider_unavailable`). Rapyd's error code goes to logs only.
- **Access:** checkout routes require `GATEWAY_TOKEN`, compared in constant time. The gateway port is bound to 127.0.0.1 in compose.
- **Sandbox:** `RAPYD_SANDBOX=true` (default) uses `sandboxapi.rapyd.net`. Rapyd does not accept localhost return URLs, so real checkout tests need a public URL.

## 008 — Webhooks confirm payments with a status request, never by trusting the event

*Status: applies to the card rail only (`PAYMENT_RAILS=rapyd`). Not on the money path since decision 017.*

- **Flow:** Rapyd calls the gateway. The gateway verifies the signature on the raw body, acknowledges with 200, and forwards a small event (`eventId`, `type`, `paymentReference`, `providerPaymentId`) to the app. The app then asks the gateway for the checkout status and applies only what Rapyd's status request confirms.
- **Why:** the webhook body is signed, but the app still checks the status with Rapyd, so a wrong or replayed event cannot move money state on its own.
- **Matching:** the event is matched to a payment by `merchant_reference_id`, which the gateway sets to the payment ID when it creates the checkout. The documentation does not say that Rapyd copies this field into the payment event, so polling is the fallback when it does not.
- **Duplicates:** each applied event ID is stored in `processed_events` in the same transaction as the state change. A payment that is no longer `awaiting_payment` is never changed by a later event.
- **Polling:** every 60 seconds, payments waiting for two minutes are checked with the checkout status. This covers lost webhooks.
- **Signature:** the webhook formula is `base64(HMAC-SHA256(url + salt + timestamp + access_key + secret_key + body))`, with the full URL configured in Rapyd (`RAPYD_WEBHOOK_URL`). The documentation does not say whether the HMAC is base64-encoded directly or as hex text, so both are accepted until a real sandbox webhook confirms which one Rapyd sends. No timestamp window is enforced, because Rapyd can resend old events.
- **Shared token:** the gateway and the app use `GATEWAY_TOKEN` in both directions. The gateway does not need `HMAC_SECRET`, which protects stored codes.

## 009 — The database is opened in one module

- **Decision:** only `backend/src/db.js` opens the connection. Startup runs pending migrations.
- **Reason:** one place to change connection settings, and one place to close it in tests.

## 010 — Live status: WebSocket with the token in the first message

- **Endpoint:** `/ws`. The client sends `{ type: "subscribe", paymentId, token }` as its first message. The token is not in the URL, so it does not appear in server or proxy logs.
- **Access:** a client sees a payment only if it belongs to the token's user, otherwise it gets `payment_not_found`. The same error is used for a missing payment, so nothing is revealed.
- **Updates:** published by an in-process event emitter after each database transaction commits. A nested transaction can publish before its outer transaction commits; the only such paths are checkout start and provider status, so a rollback there would show a status that was not saved. This does not work across several app instances; a shared bus would be needed before running more than one.
- **Refusals:** a bad or missing token, an auth timeout (10 s), and an expired session (when the token's `exp` passes) all close the socket with code 1008. The client does not retry on 1008.
- **Heartbeat:** a ping every 30 s. A client that does not answer within 10 s is dropped.
- **Browser:** `frontend/js/live-status.js` reconnects with exponential backoff (about 1 s doubling to 30 s, with jitter). It stops on 1008 and on token errors, and reports them to the caller.

## 011 — Frontend: plain pages, one API client, session token in sessionStorage

- **Stack:** plain HTML, CSS, and ES modules. No framework and no build step.
- **Session:** the token is kept in `sessionStorage`, so it clears when the tab closes. It is never written to `localStorage`. If storage is blocked, the user is simply signed out.
- **API:** every backend call goes through `frontend/js/api.js`. Every failure becomes the same `ApiError` shape (code, message, status, request ID). A 401 while signed in ends the session.
- **Sandbox banner:** the page asks `GET /api/config`, which reports `sandbox` from `RAPYD_SANDBOX`. If the config cannot be read, the banner stays hidden.
- **Layout:** one column, 16 px side margins, fluid width, colors as tokens with dark mode. Checked in headless Edge at 360 px wide: no horizontal overflow on the four pages.

## 012 — Claims: link first, then the code, then one transfer

- **Issuing:** a claim is kept only if its email is sent. The row is written first, and removed if sending fails; the payment then stays `paid` and is retried every minute. This means a stored claim always has a link that reached the recipient.
- **Storage:** only `HMAC-SHA256(token)` is stored. The token is 32 random bytes, base64url. Expiry is 7 days, and a claim can be used once.
- **Verifying the recipient:** the email must match the payment's recipient. A login-style code is then sent to that address (the same rules as decision 005: 5 attempts, 10 minutes).
- **Order of checks on confirm:** claim state, then destination, then code. A wrong destination does not use up the code.
- **Destinations:** only `https` addresses on the hosts in `CLAIM_WALLET_HOSTS` (default: the testnet host confirmed in the documentation). Query strings, fragments, and credentials are refused.
- **Single transfer:** the claim moves to `claiming` before the transfer. A second request gets `claim_in_progress`. If the transfer is not configured, the claim returns to `open` and nothing is marked failed. If the transfer fails, the payment becomes `failed`, the reason is recorded in `payment_events`, and the claim is not reopened.
- **Transfer:** injected, and not configured yet (the Open Payments transfer is blocked on prompt 08). Until it is, confirming a claim returns 503 and the claim stays open.

## 013 — Email: templates in files, logs without secrets

- **Transport:** nodemailer over SMTP. In development the app sends to the mail catcher service inside the Docker network (`SMTP_HOST=mailcatcher`), so no real inbox receives mail. If `SMTP_HOST` is empty, every send fails with 503 `email_not_configured`.
- **Templates:** one plain-text and one HTML file per email type, in `backend/src/email/templates/`. HTML values are escaped; plain-text values are not. A placeholder with no value is an error, not an empty string.
- **Failures:** a failed send becomes `email_failed` (503), so sign-in gives a clear message and no partial state is left. A failed sender notification after a claim completes is logged and does not undo the claim.
- **Logs:** an email is logged with its type and a keyed reference to the recipient (HMAC, first 12 characters). The address, the code, and the link never appear. Transport errors are logged by code only, because some messages include the address.

## 014 — Testing: built-in runner, fakes for every outside service

- **Runner:** Node's built-in test runner (`node --test`). No test framework is added.
- **No network in automated tests:** Rapyd, the gateway, email, and transfers are fakes. The database is a temporary file. The suite passes with networking disabled.
- **Manual sandbox check:** `backend/scripts/sandbox-check.js` calls the real gateway and Rapyd sandbox. It is kept out of `npm test` so that a normal test run never creates a real checkout.
- **Rule proof:** a broken transition rule must make a test fail, and that check is run whenever the state rules change.

## 015 — Scope: Rapyd for collection, Open Payments on testnet for transfers

*Status: superseded by decision 017 for the money path. Kept as history.*

- **Decision:** card money is collected through Rapyd. The transfer to the recipient uses Open Payments on the Interledger test network. Guacapay runs no node of its own.
- **Ruled out for now:** Rafiki (we would have to run an ILP node), a Guacalita node, and any Chimoney integration.
- **Reason:** the team has not chosen to operate a payment network yet. Testnet keeps the transfer leg real without taking on that operation.
- **Open:** who holds the money between collection and transfer, and which currency the testnet wallet uses (EUR, while the default accepted currency is USD). Both are recorded in `docs/OPEN_PAYMENTS.md`.
- **Superseded in part by 017:** Rapyd is no longer on the money path.

## 016 — App balance: recharges with Rapyd, payments from the balance, testnet option

- **Balance:** each user has a balance per currency in the app, changed only by movements that are recorded in `ledger_entries`. A recharge is a payment to oneself (`purpose = 'recharge'`). When Rapyd confirms it, the amount is credited and the recharge is completed. A transfer (`purpose = 'transfer'`) paid from the balance debits it in the same transaction that moves the payment to `paid`.
- **Refusal:** a payment from the balance is refused with `insufficient_balance` when the balance is too low. Nothing moves in that case.
- **Testnet option:** shown on the payment page, but it returns `testnet_not_connected` until the Open Payments transfer exists. Open Payments does not expose a wallet balance, so the app cannot display the testnet balance; it can only attempt a payment.
- **Superseded by 017:** the Rapyd recharge is switched off by default. The balance ledger stays.

## 017 — Testnet-only scope: Open Payments is the only money rail

- **Decision:** all money moves between Interledger test wallets through Open Payments. A user signs in with email and links a test wallet once, with consent. Rapyd is kept in the repository but is not on the money path. Set `PAYMENT_RAILS=rapyd` to turn the Rapyd checkout and recharge back on for development.
- **Default:** `PAYMENT_RAILS=openpayments`. With that value, `POST /api/balance/recharges` and `POST /api/payments/:id/checkout` return `rail_not_available` (503) and create nothing.
- **Ruled out:** an own Interledger node (Rafiki), a Guacalita node, Chimoney, and any cash-out. Money on the test network cannot leave it, because the test network uses play money.
- **Reason:** the hackathon asks for one payment that works end to end over Open Payments. A bridge from card money to the test network would need a node, and the team chose not to run one.
- **Consequence:** balances stay inside the test network. A user can pay other test wallets, not withdraw cash.
- **Later:** decision 020 allows a withdrawal to the user's own linked test wallet, backed by custody. It is still not cash.

## 018 — Custody wallet holds unclaimed money, and the ledger tracks each owner

- **Decision:** money for an unclaimed payment sits in one platform test wallet, the custody wallet (`CUSTODY_WALLET_ID`, `CUSTODY_WALLET_ADDRESS`). Every amount that enters or leaves it is a row in `custody_entries`, owned by exactly one payment, pool or user. A database trigger refuses any exit larger than the entries held for that owner.
- **Reason:** the recipient claims later, so the money needs a holder. A ledger per owner shows whose money it is, and the database refuses a payout the ledger cannot cover.
- **Ruled out:** paying straight from sender to recipient before the claim; a single shared pot with no owner; app-balance money leaving custody without backing.
- **Status:** written and tested offline (`custody.test.js`), not yet run on the real network.

## 019 — Pay by email is two transfers: into custody, then out to the recipient

- **Decision:** a payment is paid from the sender's wallet into custody (transfer 1, direction `in`). The payment becomes `paid` only when transfer 1 completes. The claim, then the payout to the recipient's wallet (transfer 2, direction `out`), follow the claim rules of decision 012.
- **Reason:** the recipient may claim much later, and the money must be held until then. Both transfers use the same engine, so each one records its legs.
- **Ruled out:** a single transfer to a recipient who has not claimed yet; marking a payment `paid` before the network reports completion.

## 020 — Withdrawals only up to balance backed in custody; deposits create the backing

- **Decision:** a user withdraws to their own linked wallet only up to the lower of their app balance and the amount custody holds for them, minus withdrawals in progress. A deposit (wallet to custody) credits the balance and records the custody entry. The balance is debited only when the withdrawal's transfer completes.
- **Reason:** the app balance came from Rapyd recharges, which never reach custody. Withdrawing that balance would pay out money the platform does not hold for that user. The owner chose this rule on 2026-10-17.
- **Ruled out:** withdrawing unbacked balance; debiting the balance before the transfer completes.
- **Consequence:** a Rapyd recharge balance cannot be withdrawn. Only deposits made on the test network can.

## 021 — The server calls only the Open Payments hosts it is configured for

- **Decision:** every Open Payments call checks its host against `OPEN_PAYMENTS_HOSTS` (default: the wallet host and the authorization host of the test network) before any request is sent. Wallet addresses and the servers named by wallet documents are checked the same way.
- **Reason:** a user could otherwise make the server contact any HTTPS host they named, and error answers would show whether it responded (finding F9 in `SECURITY_REVIEW.md`).
- **Ruled out:** arbitrary wallet hosts; trusting a server name taken from a wallet document without a check.
- **Status:** fixed, with a regression test (`security-review.test.js`), not yet run.

## 022 — Secret tokens never travel in a URL path

- **Decision:** the public request link token and the subscription and pool link tokens travel in a query string or a request body. The request logger writes the path, so a token in the path would be written to the log.
- **Ruled out:** `/api/requests/public/:token` style routes.
- **Consequence:** the public routes are `GET .../public?token=` and `POST .../public/pay` (with the token in the body).

## 023 — A payment request is paid straight to the requester's wallet

- **Decision:** a request is paid by one transfer from the payer's wallet to the requester's wallet. No custody and no claim step. The request becomes `paid` only when that transfer completes, and it can be paid once. The transfer is recorded with `request_id`, not as a `payments` row.
- **Reason:** the payment states have no route to `completed` without a claim. A separate row would have needed a second, parallel state machine.
- **Ruled out:** a fake `payments` row that skips states; paying the same request twice.

## 024 — A subscription's amount and interval are fixed in the offer

- **Decision:** the payee creates an offer with a fixed amount and interval. The payer approves it once, with a limit equal to one period. Each period is one charge, unique per `(subscription, period)`. Three failed charges in a row pause the subscription; a success resets the count.
- **Reason:** the payer's approval covers exactly what they saw. A repeated job run cannot charge the same period twice.
- **Ruled out:** a payee changing the amount without a new approval; more than one charge per period.

## 025 — Subscription intervals are daily, weekly or monthly, and the format is not yet verified

- **Decision:** the app supports `P1D`, `P1W` and `P1M` only. The permission's interval is sent as `R/<start>/<duration>`, following ISO 8601.
- **Reason:** three periods cover the product's use cases; a fixed list keeps the calendar arithmetic small.
- **Not verified:** the exact interval format the Open Payments authorization server expects. See `OPEN_PAYMENTS.md`.

## 026 — Group pools pay out only the contributions recorded for that period

- **Decision:** a collection pays the organizer once its total reaches the goal, or the total collected when its closing date passes. A tanda pays a period's pool to the member in that position only after every member has paid for that period. The payout amount is recomputed from completed contributions each time it starts. While a payout is in progress the pool is `closing`, and it accepts no contributions.
- **Reason:** the payout always equals what was recorded, and no contribution can change the amount mid-payout.
- **Ruled out:** partial tanda payouts; paying members who have not paid.

## 027 — A split is one payment with several child payments, each claimed separately

- **Decision:** a split checks every part before anything is created: between 2 and 20 recipients, no repeated recipient, each amount valid, and the parts add up exactly to the total. The children are created in one transaction, then paid one by one. A child that cannot be paid is marked failed, and the others go on. An optional `Idempotency-Key` returns the first split for a repeated request.
- **Reason:** one failed recipient should not stop the rest, and a retried request should not pay twice.
- **Ruled out:** creating children for parts that do not add up; a retried request paying again.

## 028 — The app never creates wallets or accounts for anyone

- **Decision:** the onboarding pages send the user to the official test-wallet site. The user verifies their own email and identity there. The pages keep their links in `frontend/config/setup.json`. No page asks for a password, a wallet code or a private key, and a test checks the frontend files for such fields.
- **Reason:** account creation and identity checks belong to the person, not to the app.
- **Ruled out:** automating sign-up or wallet login; storing wallet credentials.

## 029 — The dashboard builds its history on the client, with no HTML from strings

- **Decision:** the dashboard calls one endpoint per feature and merges the history in the browser. Every text from the server is set with `textContent`.
- **Reason:** no combined history endpoint exists yet, and merging on the client keeps the server small. Text-only rendering keeps server text from injecting markup.
- **Ruled out:** an `innerHTML` render; a server-side combined history before it is needed.

## 030 — The testnet end-to-end script is manual and uses the app's own functions

- **Decision:** `backend/scripts/testnet-e2e.js` runs only when a person starts it (`npm run e2e:testnet`), never in `npm test`. It uses the same functions the app uses, so the proof exercises the real code path. It never creates a wallet, never approves a consent, and never prints a key, token or login code. Exit code 2 means it stopped before any money moved.
- **Reason:** the proof needs real wallets, approved consent and play money, which only the owner can provide.
- **Ruled out:** a proof in the automated suite; a script that creates accounts.
- **Caveat:** the login code comes from the script's own mailer, so email delivery is not part of the proof.

## 031 — Operator endpoints use the gateway token, never a user session

- **Decision:** `/api/custody` (the custody ledger and its balances) requires the gateway token. A user's sign-in is refused. No user route returns custody balances or the custody wallet address.
- **Reason:** the custody balance is the platform's, not any user's.
- **Ruled out:** exposing custody balances to users.
