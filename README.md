# guacapay

Send money to an email address. The sender pays by card through Rapyd. The recipient receives a link, confirms their email with a code, and chooses a wallet address. The money is then transferred over Open Payments on the Interledger test network.

**Status:** in development. Sign-in, payments up to the checkout, the Rapyd sandbox, webhooks, live status, claim links and email all work in automated tests and in local containers. The money transfer is not built yet (it is blocked on the test wallet details), so a claim returns 503 for now. No real money moves.

## Who this is for

Developers who will run, test, or change the project. Start here, then read `docs/ARCHITECTURE.md`.

## What you need

- Docker Desktop (or Docker Engine with the Compose plugin).
- Node 20, only if you want to run the tests outside Docker. The tests also run inside a Node 20 container (see `docs/TESTING.md`).
- Rapyd sandbox keys and a public URL for webhooks, only for real checkout tests.

## Setup

1. Copy the example file and fill in the values:

   ```
   cp .env.example .env
   ```

2. Generate the secrets. Each command prints a 64-character value. Use a different value for each variable:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Put the values in `JWT_SECRET`, `HMAC_SECRET` and `GATEWAY_TOKEN`. The first two must be at least 32 characters, and `GATEWAY_TOKEN` too.

3. Fill in the Rapyd sandbox keys (`RAPYD_ACCESS_KEY`, `RAPYD_SECRET_KEY`) and keep `RAPYD_SANDBOX=true`.

4. Set `RAPYD_WEBHOOK_URL` to the public address Rapyd will call (for example `https://<your-host>/webhooks/rapyd`). The gateway refuses to start without it.

`.env` is git-ignored. Never commit it, and never paste its values into an issue or a chat.

## Run

From the repository root:

```
docker compose -f docker/docker-compose.yml up --build
```

| What | Where |
|---|---|
| App (sign-in, send money, payment status, claim page) | http://localhost:3202 |
| Gateway health (local only) | http://127.0.0.1:3203/health |
| Email catcher: emails sent in development | http://localhost:8026 |

The first start creates the database in the `app_data` volume and applies the migrations. The log line `migrations checked` shows which ones ran.

Stop the stack with `Ctrl+C`, or with `docker compose -f docker/docker-compose.yml down`. Add `-v` only if you want to delete the database.

## Test

```
cd backend && npm install && npm test
cd gateway && npm install && npm test
```

The automated tests need no network. A manual check runs against the real Rapyd sandbox and the test wallet. It creates one unpaid sandbox checkout, so it is never part of `npm test`:

```
cd backend && npm run test:sandbox
```

The full list of what is tested, and what is not, is in `docs/TESTING.md`.

## Using the app in development

1. Open http://localhost:3202 and enter an email address.
2. Open http://localhost:8026: the 6-digit code arrives there, not in a real inbox.
3. Enter the code. You are signed in.
4. Go to "Send money", enter a recipient email, an amount and a currency.
5. Continue to the Rapyd checkout. Pay only with sandbox cards.

Limits you will meet:

- **Returns from Rapyd:** Rapyd does not accept `localhost` return URLs. For a real checkout, `BASE_URL` must be a public address.
- **Claims:** confirming a claim returns 503 "Transfers are not available yet" until the transfer is built. The claim stays open.
- **Currency:** the default accepted currency is USD. The test wallet uses EUR. See `docs/OPEN_PAYMENTS.md`.

## Documentation

| File | What it covers |
|---|---|
| `docs/ARCHITECTURE.md` | Services, ports, and the path of one payment |
| `docs/DECISIONS.md` | Each choice, why it was made, and what it rules out |
| `docs/CONVENTIONS.md` | Naming, language, and code rules |
| `docs/TESTING.md` | How to run the tests, what they cover, and the manual sandbox check |
| `docs/OPEN_PAYMENTS.md` | The Interledger test wallet and what is still missing for transfers |
| `docs/SECURITY_REVIEW.md` | The security review, its findings, and what is still open |
| `prompts/` | The prompts used to build the project, one file per step |
| `AI_USAGE.md` | Which AI tools were used, where, and how the work was checked |
| `REFERENCE_ANALYSIS.md` | Background analysis used to plan the project |

## Repository layout

```
backend/   API, payments, claims, email, WebSocket, migrations, tests
gateway/   Rapyd adapter and webhook receiver, tests
frontend/  HTML pages, CSS and browser modules (no build step)
docker/    Compose file and the two Dockerfiles
docs/      Architecture, decisions, testing, security and provider notes
prompts/   The build steps, in order
```

## Open items

These are known and tracked in the documents above:

- The Rapyd webhook signature encoding needs one real sandbox webhook to confirm (`docs/DECISIONS.md`, decision 008).
- The Open Payments transfer needs the receiver wallet, the testnet limits, and the currency decision (`docs/OPEN_PAYMENTS.md`).
- The Open Payments key should be mounted from outside the repository before the transfer is built (`docs/SECURITY_REVIEW.md`, F6).
- The credentials in an earlier local `.env` should be rotated (`docs/SECURITY_REVIEW.md`, F8).
