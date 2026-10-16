# Prompts

Every prompt used to generate work in this repository is saved here, one file per topic, and listed in `AI_USAGE.md`.

**Status:** proposed, awaiting approval. Each prompt file is written when its prompt is given.

## Conventions

- File name: `NN-topic.md`, numbered in the order below.
- Each prompt file contains: the exact prompt text, the date, the tool and model used, and the list of files it produced.
- Prompts and documentation are in English.
- Every prompt ends with a "Done when" check that can be verified by running something or reading a file.

---

## 00 — Project setup

**File:** `00-project-setup.md`

**Goal:** an empty but correct repository skeleton, so that every later prompt has a known place to put its files.

**Steps:**
1. Create the folder layout: `backend/` (Node server), `frontend/` (pages), `docker/` (compose and Dockerfiles), `docs/`, `prompts/`.
2. Create a root `README.md` stub that points to `docs/` and `prompts/`.
3. Create a root `.gitignore` that excludes: `.env`, `node_modules/`, `*.db`, `*.db-wal`, `*.db-shm`, `keys/`, `*.key`, `logs/`, `.DS_Store`.
4. Create `.env.example` with **variable names and comments only, no values**. Proposed names:
   - `APP_PORT` (default 3202)
   - `GATEWAY_PORT` (default 3203)
   - `BASE_URL`
   - `JWT_SECRET`, `HMAC_SECRET`
   - `RAPYD_ACCESS_KEY`, `RAPYD_SECRET_KEY`, `RAPYD_SANDBOX` (true/false)
   - `OPEN_PAYMENTS_WALLET_ADDRESS`, `OPEN_PAYMENTS_KEY_ID`, `OPEN_PAYMENTS_PRIVATE_KEY_PATH`
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
5. Pin the Node version (Node 20) in `package.json` `engines` and in a `.nvmrc`.
6. Add a `docs/CONVENTIONS.md` with: file names in kebab-case, code and comments in English, one responsibility per file, environment variables read in one config module only.
7. Do **not** create a git commit. Leave changes in the working tree for review.

**Deliverables:** folder layout, `README.md` stub, `.gitignore`, `.env.example`, `.nvmrc`, `docs/CONVENTIONS.md`.

**Done when:**
- Every folder listed in step 1 exists.
- `git check-ignore` (run by you) reports `.env` and `keys/` as ignored.
- `.env.example` contains no real values.
- `docs/CONVENTIONS.md` exists and matches the rules above.

**Open decisions for you before this prompt:**
- Is `APP_PORT` 3202 and `GATEWAY_PORT` 3203 correct for guacapay?
- Do you want the variable names above, or your own?

---

## 01 — Docker Compose stack

**File:** `01-docker-compose.md`

**Goal:** one `docker compose up` starts everything needed locally, with no external services except Rapyd and the Open Payments testnet.

**Steps:**
1. Define services: `app` (backend + frontend served by the backend), `gateway` (Rapyd adapter, see prompt 06), and `mailcatcher` (local email UI).
2. Map ports: app to 3202, gateway to 3203, mail catcher UI to 8026.
3. Add a health check per service that calls its `/health` endpoint.
4. Mount a named volume for the SQLite database file and a read-only bind mount for the keys folder.
5. Load environment from `.env` through `env_file`, never hard-coded.
6. No database server (Postgres, Redis) unless a later prompt proves it is needed.

**Deliverables:** `docker/docker-compose.yml`, one Dockerfile per Node service.

**Done when:**
- `docker compose config` validates without errors.
- `docker compose up --build` starts all services and each health check turns "healthy".
- Port 3202 responds on `/health`, port 3203 responds on `/health`, port 8026 shows the mail UI.

---

## 02 — Backend core

**File:** `02-backend-core.md`

**Goal:** a minimal Express server with config, logging, and error handling, which every other backend prompt builds on.

**Steps:**
1. Create `backend/src/config.js`: the only file that reads `process.env`. It validates required variables at startup and fails with a clear message if one is missing.
2. Create `backend/src/server.js`: Express app, JSON body parser, static file serving for `frontend/`.
3. Add `GET /health` returning `{ ok: true, service, version }`.
4. Add one error middleware that returns `{ error: { code, message } }` and never leaks stack traces when `NODE_ENV=production`.
5. Add a small logger with levels and no secret values in output.
6. Add a request ID per request, returned in the `X-Request-Id` header.

**Deliverables:** `backend/src/config.js`, `backend/src/server.js`, `backend/src/logger.js`, `backend/src/errors.js`.

**Done when:**
- Starting without `JWT_SECRET` exits with an error that names the variable.
- `GET /health` returns 200 and the JSON shape above.
- An unknown route returns the standard error JSON, not HTML.

---

## 03 — Backend database

**File:** `03-backend-database.md`

**Goal:** a persistent store with a clear schema for users, OTP codes, payments, and claims.

**Steps:**
1. Choose SQLite via `better-sqlite3` (file in a Docker volume). Reason: one service, no extra container, enough for the testnet stage. Document the reason in `docs/DECISIONS.md`.
2. Create a migration runner: numbered SQL files in `backend/migrations/`, applied in order, recorded in a `schema_migrations` table.
3. First migration tables:
   - `users` (id, email unique, created_at)
   - `otp_codes` (id, email, code_hash, expires_at, attempts, used_at)
   - `payments` (id, sender_id, recipient_email, amount_cents, currency, status, rapyd_checkout_id, created_at, updated_at)
   - `claims` (id, payment_id unique, token_hash, status, destination, claimed_at)
   - `payment_events` (id, payment_id, type, payload_json, created_at) for an audit trail.
4. Store OTP codes and claim tokens **hashed**, never in plain text.
5. Create `backend/src/db.js` as the only module that touches the database.

**Deliverables:** `backend/migrations/001-initial.sql`, `backend/src/db.js`, `backend/src/migrate.js`, `docs/DECISIONS.md`.

**Done when:**
- Running migrations twice changes nothing the second time.
- The tables exist with the columns above.
- A test inserts a payment and reads it back.

---

## 04 — Backend auth (one-time code)

**File:** `04-backend-auth-otp.md`

**Goal:** a user proves control of an email address with a one-time code, and receives a session token.

**Steps:**
1. `POST /api/auth/request-code` with `{ email }`: validate the email, generate a 6-digit code, store its hash with a 10-minute expiry, send it by email (see prompt 13).
2. `POST /api/auth/verify-code` with `{ email, code }`: check hash, expiry, and attempts (max 5). On success, mark the code used and return a JWT valid for 1 hour.
3. Rate limit `request-code`: max 3 requests per email per 15 minutes, and per IP.
4. Constant-time comparison for code hashes.
5. Add an auth middleware `requireAuth` that reads the JWT from the `Authorization` header.

**Deliverables:** `backend/src/auth/` (routes, service, middleware), tests.

**Done when:**
- A correct code returns a token; a wrong code five times blocks further attempts.
- An expired code is rejected.
- The fourth request within 15 minutes is rejected with 429.
- A request without a token to a protected route returns 401.

---

## 05 — Backend payments

**File:** `05-backend-payments.md`

**Goal:** the internal payment record and its lifecycle, independent of any payment provider.

**Steps:**
1. Define states: `created` → `awaiting_payment` → `paid` → `claimable` → `claimed` → `completed`, plus `expired` and `failed`.
2. Allowed transitions written in one table in `backend/src/payments/states.js`. Any other transition throws.
3. `POST /api/payments` (authenticated): validate recipient email, amount (integer cents, min and max), currency. Create the payment in `created`.
4. `GET /api/payments/:id` and `GET /api/payments` for the sender only.
5. Every state change writes a row in `payment_events`.
6. Idempotency key: the client sends `Idempotency-Key`; repeating the same key returns the same payment.

**Deliverables:** `backend/src/payments/` (routes, service, states), tests.

**Done when:**
- An invalid transition (for example `claimed` → `created`) throws.
- Sending the same request twice with the same key creates one payment.
- Every state change has an event row.
- A user cannot read another user's payment (returns 404, not 403).

---

## 06 — Rapyd adapter

**File:** `06-rapyd-adapter.md`

**Goal:** all Rapyd calls live in one module. The rest of the app never calls Rapyd directly.

**Steps:**
1. Create `backend/src/providers/rapyd.js` with: `createCheckout(payment)`, `getCheckoutStatus(checkoutId)`.
2. Sign every request with Rapyd's signature scheme (salt, timestamp, HMAC of method, path, body, using `RAPYD_ACCESS_KEY` and `RAPYD_SECRET_KEY`). Follow the reference at https://docs.rapyd.net/es/index-es.html.
3. Use `RAPYD_SANDBOX` to pick the sandbox base URL.
4. Timeouts (10 s), and retries only for network errors, never for 4xx responses.
5. Map Rapyd errors to our error codes. Never return raw Rapyd responses to the browser.
6. The adapter is the only place that knows Rapyd field names.

**Deliverables:** `backend/src/providers/rapyd.js`, tests with mocked HTTP.

**Done when:**
- Unit tests show the signature matches the documented example for a fixed salt and timestamp.
- A sandbox call creates a checkout and returns a URL (manual check with real sandbox keys).
- A 401 from Rapyd becomes our `provider_auth_failed` error.

---

## 07 — Rapyd webhooks

**File:** `07-rapyd-webhooks.md`

**Goal:** Rapyd tells us when a checkout is paid, and we update the payment exactly once.

**Steps:**
1. `POST /webhooks/rapyd`: verify the Rapyd signature before reading the body.
2. Map the event to a payment by checkout ID. Unknown IDs are logged and acknowledged with 200.
3. Apply the state transition to `paid` only if the payment is still `awaiting_payment`. Duplicate events do nothing.
4. Polling fallback: a job every 60 seconds checks `awaiting_payment` payments older than 2 minutes via `getCheckoutStatus`.
5. Respond 200 quickly; do the work after the response if needed.

**Deliverables:** `backend/src/webhooks/rapyd.js`, polling job, tests.

**Done when:**
- A webhook with a bad signature returns 401 and changes nothing.
- Sending the same paid event twice leaves one `paid` event in `payment_events`.
- A payment is marked `paid` by the poller when the webhook is blocked.

---

## 08 — Open Payments on Interledger testnet

**File:** `08-openpayments-testnet.md`

**Goal:** the transfer leg. After a payment is paid and claimed, money moves to the recipient's wallet on the Interledger testnet using Open Payments. No own nodes, no Rafiki.

**Steps:**
1. Confirm the testnet wallet provider, its URLs, and how to register a sender wallet and a test receiver wallet. Document the answers in `docs/OPEN_PAYMENTS.md`. This is blocking.
2. Create `backend/src/providers/openpayments.js`, the only module that uses `@interledger/open-payments`.
3. Load the Ed25519 key pair from `OPEN_PAYMENTS_PRIVATE_KEY_PATH`. The key file lives outside the repo.
4. Functions:
   - `getWalletAddress(url)`
   - `createIncomingPayment(receiverWallet, amount)`
   - `createQuote(senderWallet, incomingPayment)`
   - `createOutgoingPayment(senderWallet, quote)`
   - `getOutgoingPaymentStatus(id)`
5. Store the grant and payment IDs on the payment record.

**Deliverables:** `backend/src/providers/openpayments.js`, `docs/OPEN_PAYMENTS.md`.

**Done when:**
- Fetching the testnet sender and receiver wallet addresses works.
- A test transfer between two testnet wallets reaches `COMPLETED` (manual check).
- The private key never appears in logs or in the repo.

---

## 09 — WebSocket (live status)

**File:** `09-websocket.md`

**Goal:** the browser sees payment status changes without refreshing.

**Steps:**
1. Add a WebSocket server on the app port at `/ws`.
2. Client sends `{ type: "subscribe", paymentId }` after authenticating with the same JWT.
3. The server sends `{ type: "payment.updated", paymentId, status }` when `payment_events` gets a new row for that payment.
4. Only the payment's sender receives its updates.
5. Heartbeat ping every 30 seconds; close idle connections.

**Deliverables:** `backend/src/ws/`, `frontend/js/live-status.js`.

**Done when:**
- Two browser tabs: changing a payment's status in one updates the other within 1 second.
- A client subscribing to someone else's payment receives an error and no data.

---

## 10 — Frontend shell

**File:** `10-frontend-shell.md`

**Goal:** the basic pages and navigation, without payment logic yet.

**Steps:**
1. Plain HTML, CSS, and JavaScript modules. No framework unless you decide otherwise.
2. Pages: `index.html` (home), `new.html` (new payment), `payment.html?id=` (status), `claim.html?token=` (claim, see prompt 12).
3. A shared `frontend/js/api.js` that adds the JWT and handles errors in one place.
4. Responsive layout that works on a phone-width screen.
5. Visible "sandbox" banner when the backend reports `RAPYD_SANDBOX=true`.

**Deliverables:** `frontend/` pages, `frontend/css/`, `frontend/js/api.js`.

**Done when:**
- All four pages load from port 3202 without console errors.
- The sandbox banner appears when sandbox mode is on.

---

## 11 — Frontend payment flow

**File:** `11-frontend-payment-flow.md`

**Goal:** a sender enters recipient and amount, pays with Rapyd, and sees the result.

**Steps:**
1. Login form on `index.html`: email, then code (prompt 04).
2. `new.html`: recipient email, amount, optional message. Validate in the browser and on the server.
3. On submit: create the payment, then redirect to the Rapyd checkout URL.
4. After return, `payment.html` shows status and listens to live updates (prompt 09).
5. Show clear messages for each state.

**Deliverables:** pages and scripts for login and new payment.

**Done when:**
- A sandbox payment goes from form to Rapyd checkout and back.
- Invalid amounts show an inline message and do not call the API.

---

## 12 — Claim flow

**File:** `12-claim-flow.md`

**Goal:** the recipient receives a link, proves their email, and chooses where the money goes.

**Steps:**
1. When a payment becomes `paid`, create a claim with a random token. Store only its hash. Email the link `BASE_URL/claim.html?token=...` (prompt 13).
2. Claim page: enter recipient email, receive a one-time code (prompt 04), verify it.
3. Destination choice: a test Open Payments wallet address (prompt 08). Only testnet addresses in this stage.
4. On confirm, the state moves to `claimed`, then the transfer runs (prompt 08), then `completed`.
5. Claim tokens expire after 7 days and can be used once.

**Deliverables:** `backend/src/claims/`, `frontend/claim.html`, tests.

**Done when:**
- The link works once; a second use is rejected.
- An expired token is rejected.
- A full run ends with the payment `completed` and a confirmation email to the sender.

---

## 13 — Email notifications

**File:** `13-email-notifications.md`

**Goal:** the three emails the app sends: login code, claim link, payment confirmation.

**Steps:**
1. `backend/src/email/` with one function per email type. Templates are plain text plus simple HTML.
2. In development, SMTP points to the mail catcher service (prompt 01), so no real email leaves the machine.
3. No secret values or full tokens in the email log; log only the message type and recipient hash.

**Deliverables:** `backend/src/email/`, templates.

**Done when:**
- All three emails appear in the mail catcher UI at port 8026.
- The logs show the email type but not the code or the claim token.

---

## 14 — Testing

**File:** `14-testing.md`

**Goal:** automated checks that run with one command.

**Steps:**
1. Unit tests for: states, OTP logic, Rapyd signature, webhook verification, claim token logic.
2. Integration test: request code → verify → create payment → mock Rapyd paid webhook → claim → mock transfer → completed.
3. A manual sandbox test script, separate from CI, that runs against real Rapyd sandbox and testnet.
4. One command: `npm test` for automated tests, `npm run test:sandbox` for the manual one.

**Deliverables:** `backend/test/`, `docs/TESTING.md`.

**Done when:**
- `npm test` passes with no network access.
- The sandbox script prints each step's result and fails with a clear message.

---

## 15 — Security review

**File:** `15-security-review.md`

**Goal:** check the rules from the reference analysis against the code.

**Steps:**
1. Confirm no secret is committed (search for keys, tokens, `.env` content).
2. Confirm all input is validated on the server, not only in the browser.
3. Confirm Rapyd webhooks and polling are idempotent.
4. Confirm the OTP and claim token are hashed at rest.
5. Confirm error responses do not leak stack traces or provider internals.
6. Confirm the Open Payments key is read from a path outside the repo and never logged.
7. Write findings in `docs/SECURITY_REVIEW.md` with severity and status.

**Deliverables:** `docs/SECURITY_REVIEW.md`, and fixes for any high-severity finding.

**Done when:** every item above has a status of "pass" or a linked fix.

---

## 16 — Documentation

**File:** `16-docs.md`

**Goal:** someone new can run the project from the README alone.

**Steps:**
1. `README.md`: what it does, requirements (Docker, Node 20), setup steps, how to run, how to test.
2. `docs/ARCHITECTURE.md`: services, ports, data flow, a diagram in text.
3. `docs/DECISIONS.md`: each choice and its reason (SQLite, Rapyd only, testnet only, no own nodes).
4. Keep `AI_USAGE.md` current with the prompts used.

**Deliverables:** the four documents above.

**Done when:** a person who did not build the project can follow the README to a running sandbox in under 30 minutes.
