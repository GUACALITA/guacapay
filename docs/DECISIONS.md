# Decisions

Each entry records a choice, its reason, and what it rules out.

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
- **Email:** sending goes through an interface. Until the email module exists (prompt 13), requesting a code returns 503, so no code is sent or logged.

## 006 — Payment states, transitions, and idempotency

- **Decision:** payments move through eight states (`created`, `awaiting_payment`, `paid`, `claimable`, `claimed`, `completed`, `expired`, `failed`). The allowed moves are one table in `backend/src/payments/states.js`. Any other move is rejected and writes nothing.
- **Events:** every state change writes one `payment_events` row in the same transaction as the change. Creation is recorded as a move from nothing to `created`.
- **Idempotency:** the optional `Idempotency-Key` header is unique per sender. A repeat with the same details returns the original payment (200). A repeat with different details returns 409.
- **Money:** amounts are integer cents. Limits and accepted currencies come from configuration (`PAYMENT_MIN_CENTS`, `PAYMENT_MAX_CENTS`, `PAYMENT_CURRENCIES`).
- **Visibility:** a user who does not own a payment gets the same 404 as for a payment that does not exist.

## 007 — Rapyd is reached only through the gateway

- **Decision:** the app never calls Rapyd. It calls the gateway over HTTP, and only the gateway's `providers/rapyd.js` knows Rapyd URLs, field names, and signing.
- **Signing:** as documented, `base64(hex(HMAC-SHA256(secret, method + path + salt + timestamp + access_key + secret + body)))`. Salt is 16 hex characters. The body is empty for GET and compact JSON for POST.
- **Retries:** only network errors and timeouts are retried (twice). Each attempt gets a new salt and timestamp, and POST keeps the same `idempotency` header (the payment ID), so a retry cannot create a second checkout.
- **Errors:** Rapyd errors become our codes (`provider_auth_failed`, `provider_rejected`, `provider_unavailable`). Rapyd's error code goes to logs only.
- **Access:** checkout routes require `GATEWAY_TOKEN`, compared in constant time. The gateway port is bound to 127.0.0.1 in compose.
- **Sandbox:** `RAPYD_SANDBOX=true` (default) uses `sandboxapi.rapyd.net`. Rapyd does not accept localhost return URLs, so real checkout tests need a public URL.

## 008 — Webhooks confirm payments with a status request, never by trusting the event

- **Flow:** Rapyd calls the gateway. The gateway verifies the signature on the raw body, acknowledges with 200, and forwards a small event (`eventId`, `type`, `paymentReference`, `providerPaymentId`) to the app. The app then asks the gateway for the checkout status and applies only what Rapyd's status request confirms.
- **Why:** the webhook body is signed, but the app still checks the status with Rapyd, so a wrong or replayed event cannot move money state on its own.
- **Matching:** the event is matched to a payment by `merchant_reference_id`, which the gateway sets to the payment ID when it creates the checkout. The documentation does not say that Rapyd copies this field into the payment event, so polling is the fallback when it does not.
- **Duplicates:** each applied event ID is stored in `processed_events` in the same transaction as the state change. A payment that is no longer `awaiting_payment` is never changed by a later event.
- **Polling:** every 60 seconds, payments waiting for two minutes are checked with the checkout status. This covers lost webhooks.
- **Signature:** the webhook formula is `base64(HMAC-SHA256(url + salt + timestamp + access_key + secret_key + body))`, with the full URL configured in Rapyd (`RAPYD_WEBHOOK_URL`). The documentation does not say whether the HMAC is base64-encoded directly or as hex text, so both are accepted until a real sandbox webhook confirms which one Rapyd sends. No timestamp window is enforced, because Rapyd can resend old events.
- **Shared token:** the gateway and the app use `GATEWAY_TOKEN` in both directions. The gateway does not need `HMAC_SECRET`, which protects stored codes.

## 010 — Live status: WebSocket with the token in the first message

- **Endpoint:** `/ws`. The client sends `{ type: "subscribe", paymentId, token }` as its first message. The token is not in the URL, so it does not appear in server or proxy logs.
- **Access:** a client sees a payment only if it belongs to the token's user, otherwise it gets `payment_not_found`. The same error is used for a missing payment, so nothing is revealed.
- **Updates:** published by an in-process event emitter after each database transaction commits. A nested transaction can publish before its outer transaction commits; the only such paths are checkout start and provider status, so a rollback there would show a status that was not saved. This does not work across several app instances; a shared bus would be needed before running more than one.
- **Refusals:** a bad or missing token, an auth timeout (10 s), and an expired session (when the token's `exp` passes) all close the socket with code 1008. The client does not retry on 1008.
- **Heartbeat:** a ping every 30 s. A client that does not answer within 10 s is dropped.
- **Browser:** `frontend/js/live-status.js` reconnects with exponential backoff (about 1 s doubling to 30 s, with jitter). It stops on 1008 and on token errors, and reports them to the caller.

## 009 — The database is opened in one module

- **Decision:** only `backend/src/db.js` opens the connection. Startup runs pending migrations.
- **Reason:** one place to change connection settings, and one place to close it in tests.
