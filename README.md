# guacapay

Pay someone by email with Interledger test wallets, through Open Payments. Money moves only between test wallets, in play money. It cannot be turned into cash.

**Status:** in development. The code for the flows below is written. The automated tests for them are written but **have not been run yet**, and no payment has been made on the real test network yet. See "What works, and how it is checked" below.

## What the product does

| Feature | What a user does |
|---|---|
| Pay by email | Sends money to an email address. The recipient gets a link, signs in with a code, gives a wallet address, and the money goes to that wallet. |
| Requests and QR | Creates a request with an amount and a note, and shares the link or its QR code. The payer pays from their own linked wallet. |
| Subscriptions | Offers a recurring charge. The payer approves it once, with a limit and a period. Each period is charged once; three failed charges pause it; the payer can cancel. |
| Tandas and collections | A group pays into one goal (a collection) or a rotating circle (a tanda). A payout only goes out when the group's contributions for that period are complete. |
| Splits | One payment to several people, each with their own claim. |
| Withdraw to your own wallet | Moves money from the app to a test wallet the user owns. Only money backed in the platform's custody can be withdrawn. |

Money on the test network stays there. The app never converts it to cash, and never moves it to another system.

## What you need

- **Docker Desktop.** Nothing else on your computer. Node is not needed to run the app.
- **A test wallet, which you create yourself** on the official Interledger test wallet site. The app does not create wallets or accounts for you. Open `wallet-setup.html` in the app for the steps; it links to the official site.
- **Settings in `.env`:** only the platform's Open Payments values (`OPEN_PAYMENTS_*`). The app generates its own secrets (sign-in, signing, and the encryption of permission tokens) on its first start and keeps them in its data folder. You do not create or paste them.
- **Rapyd sandbox keys only if you use the card path** (`PAYMENT_RAILS=rapyd`, for development). The test-wallet product does not need them.

## Quick start

Open **PowerShell** (Windows) or **Terminal** (macOS). Run everything from the project folder.

### 1. Create your `.env` file, only for the platform's test-wallet values

```
copy .env.example .env
```

The app creates its own secrets on its first start, so you do not generate or paste any. `.env` is ignored by git, so it is never uploaded. Do not add secrets to it.

### 2. Fill in the test-wallet values

Open `.env` and set the Open Payments, custody and currency values from `.env.example`. Use the values of your own test wallet and your own custody wallet. Do not paste them anywhere else.

### 3. Start everything

```
docker compose --env-file .env -f docker/docker-compose.yml up --build
```

Wait until the log shows `app listening`. Leave the window open. Press `Ctrl+C` to stop.

### 4. Check that it answers

```
curl http://localhost:3202/health
```

It should answer `{"ok":true,...}`. Then open http://localhost:3202 in your browser. Sign-in codes arrive at the email inbox for development, at http://localhost:8026.

## What works, and how it is checked

Each row names the test that checks it. A test is **written** when it exists in the repository, and **run** only after a passing test run is recorded. The rows below are all written; **none has been run yet**, at the owner's request.

| Claim | Check | Status |
|---|---|---|
| A wallet is linked once, with consent | `backend/test/wallets.test.js`, `grants.test.js` | written, not run |
| A consent can be finished once; expired and revoked permissions are refused | `backend/test/grants.test.js` | written, not run |
| Pay by email moves money to custody, then to the recipient | `backend/test/payment-flow.test.js` (fake network); `backend/scripts/testnet-e2e.js` (real network, manual) | written, not run; real network **not yet verified** |
| A payout never exceeds custody | `backend/test/custody.test.js` | written, not run |
| A transfer is recorded in legs, and a retry never sends twice | `backend/test/transfers.test.js` | written, not run |
| Requests: create, pay once, expire, QR decodes to the link | `backend/test/requests.test.js` | written, not run |
| Subscriptions: one charge per period, three failures pause, cancel revokes | `backend/test/subscriptions.test.js` | written, not run; interval format **not verified** |
| Pools: collection pays the total; tanda waits for everyone; no double contribution | `backend/test/pools.test.js` | written, not run |
| Splits: parts that do not add up create nothing; one failed part does not stop the others | `backend/test/splits.test.js` | written, not run |
| Withdrawals: debited once, after completion; refused above the backed balance | `backend/test/withdrawals.test.js` | written, not run |
| The onboarding pages have no password, code or key fields | `backend/test/frontend-setup.test.js` | written, not run |
| The dashboard uses no HTML from strings and no inline styles | `backend/test/frontend-dashboard.test.js` | written, not run |
| The server contacts only the test network's hosts | `backend/test/security-review.test.js` | written, not run |

**Not yet verified on the real test network:** every flow above. The first real run is `npm run e2e:testnet` (see `docs/E2E_RUN.md`). It needs two linked test wallets, an approved consent, and play money.

**Not built yet:** screens for deposits, withdrawals, splits, creating subscriptions and pools, and the payer's pages for requests, offers and pool joins. The API exists for each of these.

## Run the tests

The tests need Node 20. Run them in a container, so Node is not needed on your computer:

```
docker run --rm -v "C:\Users\guacalita-ceo-jlgb\Documents\GitHub\guacapay:/repo" -w /repo/backend node:20-alpine sh -c "npm install && npm test"
```

Change the folder path to yours. The automated tests use no network. `docs/TESTING.md` lists what each suite covers.

## The public address (only for the card path)

Rapyd must reach your computer to report card payments. That is needed only with `PAYMENT_RAILS=rapyd`. The test-wallet flows do not need a public address, except for the consent callback when a wallet sends the user back to the app (`RETURN_BASE_URL`). See `docs/ARCHITECTURE.md`.

## If something does not work

| You see | What to do |
|---|---|
| `[config] JWT_SECRET is required` (or another name) | That variable is empty in `.env`. Fill it in and start again. |
| `[config] ... must be at least 32 characters` | The secret is too short. Generate a new one with the command in step 1. |
| `Bind for 0.0.0.0:3202 failed: port is already allocated` | Another program uses the port. Change `APP_PORT` in `.env`, for example `APP_PORT=3302`. |
| Sign-in says "We could not send the email" | The email inbox container is not running. Check `docker compose --env-file .env -f docker/docker-compose.yml ps`. |
| "Transfers are not available yet" | The custody wallet is not configured. Set `CUSTODY_WALLET_ID` and `CUSTODY_WALLET_ADDRESS`. |
| "That wallet host is not accepted here" | The wallet is not on the test network. Use a wallet on a host listed in `OPEN_PAYMENTS_HOSTS`. |

## Stop, restart, and reset

| Action | Command |
|---|---|
| Stop (keeps the database) | Press `Ctrl+C`, then `docker compose --env-file .env -f docker/docker-compose.yml down` |
| Start again | `docker compose --env-file .env -f docker/docker-compose.yml up --build` |
| Delete the database and start clean | `docker compose --env-file .env -f docker/docker-compose.yml down -v` |

## Documentation

| File | What it covers |
|---|---|
| `docs/ARCHITECTURE.md` | Services, the money path, custody, the transfer engine, grants, states |
| `docs/DECISIONS.md` | Each choice, why it was made, and what it rules out (017 onward is the testnet scope) |
| `docs/OPEN_PAYMENTS.md` | Facts verified on the test network, with dates and sources, and the open items |
| `docs/TESTING.md` | The test suites, the manual checks, and what is not covered |
| `docs/E2E_RUN.md` | The output of the first real run (pending) |
| `docs/SECURITY_REVIEW.md` | The security reviews, their findings, and what is still open |
| `docs/CONVENTIONS.md` | Naming, language, and code rules |
| `prompts/` | The prompts used to build the project, one file per step |
| `AI_USAGE.md` | Which AI tools were used, where, and how the work was checked |

## Open items

- The first real transfer between two test wallets (`docs/E2E_RUN.md`).
- Interval format for subscriptions, and the other Open Payments facts still open (`docs/OPEN_PAYMENTS.md`).
- Credentials that were in an earlier commit must be rotated, and the history decision made (`docs/SECURITY_REVIEW.md`, F10 and F8).
- Remote revocation of permissions (`docs/SECURITY_REVIEW.md`, F11).
- The Rapyd webhook signature encoding, for the card path only (`docs/DECISIONS.md`, 008).
