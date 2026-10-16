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

## 008 — The database is opened in one module

- **Decision:** only `backend/src/db.js` opens the connection. Startup runs pending migrations.
- **Reason:** one place to change connection settings, and one place to close it in tests.
