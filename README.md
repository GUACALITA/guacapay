# guacapay

Send money to an email address. The sender pays by card through Rapyd. The recipient receives a link, confirms their email with a code, and chooses a wallet address. The money is then transferred over Open Payments on the Interledger test network.

**Status:** in development. Sign-in, payments up to the Rapyd checkout, webhooks, live status, claim links and email work in automated tests and in local containers. The money transfer is not built yet, so a claim returns 503 for now. No real money moves.

## What you need

Only **Docker Desktop** is required to run the project. You do not need Node installed on your computer.

Docker Desktop: https://www.docker.com/products/docker-desktop/ (install it, start it, and wait until it says it is running).

To run the project you also need:

| Item | Required? | Where it comes from |
|---|---|---|
| Three secrets (`JWT_SECRET`, `HMAC_SECRET`, `GATEWAY_TOKEN`) | Yes | Generated on your machine (step 2 below) |
| Rapyd sandbox keys (`RAPYD_ACCESS_KEY`, `RAPYD_SECRET_KEY`) | Yes | Rapyd sandbox dashboard, after you create an account |
| A public web address for Rapyd's webhooks (`RAPYD_WEBHOOK_URL`) | Yes | See "Public address" below |
| Your app's public address (`BASE_URL`) | Yes for real payments | Same as above |
| Open Payments test wallet values (`OPEN_PAYMENTS_*`) | No, not yet | Needed only for the money transfer, which is not built |

## Quick start from zero

Open **PowerShell** (Windows) or **Terminal** (macOS). Every command below runs from the project folder.

### 1. Go to the project folder

```
cd C:\Users\guacalita-ceo-jlgb\Documents\GitHub\guacapay
```

On macOS or Linux, use the folder where you cloned the project, for example `cd ~/guacapay`.

### 2. Create your `.env` file and generate the three secrets

Copy the example file:

```
copy .env.example .env
```

On macOS or Linux, use `cp .env.example .env`.

Generate the secrets. This uses Docker only. Run the command **three times**, and paste each result into a different variable:

```
docker run --rm node:20-alpine node -p "require('crypto').randomBytes(32).toString('hex')"
```

Each command prints a 64-character value. Use one value for `JWT_SECRET`, another for `HMAC_SECRET`, and another for `GATEWAY_TOKEN`. Never reuse a value, and never share them.

### 3. Fill in the other values in `.env`

Open the file:

```
notepad .env
```

Fill in these lines. Keep the names exactly as they are:

```
JWT_SECRET=<first generated secret>
HMAC_SECRET=<second generated secret>
GATEWAY_TOKEN=<third generated secret>

RAPYD_ACCESS_KEY=<your Rapyd sandbox access key>
RAPYD_SECRET_KEY=<your Rapyd sandbox secret key>
RAPYD_SANDBOX=true

RAPYD_WEBHOOK_URL=<public address, see below>
BASE_URL=<public address of the app, see below>
```

Leave the other lines empty. Their defaults are correct for a local run. Open Payments values are not needed yet.

Save the file and close the editor. `.env` is ignored by git, so it is never uploaded. Do not paste its contents anywhere.

### 4. Start everything

```
docker compose -f docker/docker-compose.yml up --build
```

The first start takes a few minutes, because Docker downloads and builds the images. Wait until the log shows lines like `app listening` and `gateway listening`. Leave this window open. To stop later, press `Ctrl+C`.

### 5. Check that it works

Open a second PowerShell window and run:

```
curl http://localhost:3202/health
curl http://127.0.0.1:3203/health
```

Both should answer `{"ok":true,...}`. Then open these pages in your browser:

| What | Address |
|---|---|
| The app (sign-in, send money) | http://localhost:3202 |
| Email inbox for development (sign-in codes arrive here) | http://localhost:8026 |

## The public address (for Rapyd)

Rapyd must reach your computer to report payments, and Rapyd does not accept `localhost` return addresses. So for real payments you need a public `https` address that points to your computer.

The simplest option is a tunnel tool such as Cloudflare Tunnel (`cloudflared`) or ngrok. Point the tunnel to your computer's port `3202` for the app, and to `3203` for the gateway. Then:

- Set `BASE_URL` to the public address of the app, for example `https://your-tunnel-name.example.com`.
- Set `RAPYD_WEBHOOK_URL` to the public address of the gateway plus `/webhooks/rapyd`. The gateway listens on port `3203`, so the tunnel must reach that port. For example `https://your-gateway-tunnel.example.com/webhooks/rapyd`.
- In the Rapyd sandbox dashboard, configure the same webhook URL.

Without a public address, sign-in, the payment page and the dashboard still work locally. Only the checkout's return and Rapyd's webhooks need the public address.

**The gateway will not start if `RAPYD_WEBHOOK_URL` is empty.** It prints `[config] RAPYD_WEBHOOK_URL must be an absolute http or https URL`. Put any valid `https` address there to start it; real payments need the public one.

## If something does not work

| You see | What to do |
|---|---|
| `[config] JWT_SECRET is required` (or another name) | That variable is empty in `.env`. Fill it in and start again. |
| `[config] ... must be at least 32 characters` | The secret is too short. Generate a new one with the command in step 2. |
| `Bind for 0.0.0.0:3202 failed: port is already allocated` | Another program uses the port. Change `APP_PORT` (or `GATEWAY_PORT`, or the email inbox port in `docker/docker-compose.yml`) in `.env`, for example `APP_PORT=3302`. Then open the new port. |
| Sign-in says "We could not send the email" | The email inbox container is not running. Check with `docker compose -f docker/docker-compose.yml ps` that `mailcatcher` is up, then start the stack again. |
| Checkout says "Payments are not available right now" | Check the gateway log for `provider_auth_failed`: the Rapyd keys are wrong. |
| Rapyd rejects the return address | Use a public `BASE_URL`, not `localhost`. |

To see logs for one service, open a new PowerShell window and run, for example:

```
docker compose -f docker/docker-compose.yml logs -f app
```

## Stop, restart, and reset

| Action | Command |
|---|---|
| Stop (keeps the database) | Press `Ctrl+C` in the window where it runs, then run `docker compose -f docker/docker-compose.yml down` |
| Start again | `docker compose -f docker/docker-compose.yml up --build` |
| Delete the database and start clean | `docker compose -f docker/docker-compose.yml down -v` |

## Run the tests

The tests need Node 20. You can run them inside a container, so Node is not needed on your computer:

```
docker run --rm -v "C:\Users\guacalita-ceo-jlgb\Documents\GitHub\guacapay:/repo" -w /repo/backend node:20-alpine sh -c "npm install && npm test"
docker run --rm -v "C:\Users\guacalita-ceo-jlgb\Documents\GitHub\guacapay:/repo" -w /repo/gateway node:20-alpine sh -c "npm install && npm test"
```

Change the folder path to yours. The automated tests need no network. A manual check calls the real Rapyd sandbox, creates one unpaid checkout, and needs the gateway running. See `docs/TESTING.md`.

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

## Open items

- The Rapyd webhook signature encoding needs one real sandbox webhook to confirm (`docs/DECISIONS.md`, decision 008).
- The Open Payments transfer needs the receiver wallet, the testnet limits, and the currency decision (`docs/OPEN_PAYMENTS.md`).
- The Open Payments key should be mounted from outside the repository before the transfer is built (`docs/SECURITY_REVIEW.md`, F6).
- Credentials from an earlier local `.env` should be rotated (`docs/SECURITY_REVIEW.md`, F8).
