# Testing

Automated tests use Node's built-in test runner (`node --test`). No test framework is installed. This choice is recorded in `DECISIONS.md`. The automated tests do not use the network: they run against a temporary SQLite file, fake mail, fake Rapyd, and fake transfers.

## How to run

| What | Command | Needs |
|---|---|---|
| Backend tests (includes the frontend checks) | `cd backend && npm test` | Node 20, `npm install` |
| Gateway tests | `cd gateway && npm test` | Node 20, `npm install` |
| Sandbox check (manual) | `cd backend && npm run test:sandbox` | gateway running, real sandbox keys in `.env` |

Without Node installed on the host, run the tests in the same image the app uses:

```
docker run --rm -v "<repo>:/repo" -w /repo/backend node:20-alpine sh -c "npm install && npm test"
```

To prove the tests need no network, add `--network none`. The backend suite and the gateway suite both pass that way.

## What each rule is tested by

| Rule | Where it is tested |
|---|---|
| Payment states and allowed moves | `backend/test/payments.test.js` (transitions, terminal states, one event per change) |
| Payment input limits and idempotency | `backend/test/payments.test.js` |
| One-time code rules: 6 digits, 10-minute expiry, 5 attempts, single use, rate limits, same answer for known and unknown addresses | `backend/test/auth.test.js` |
| Login token: user ID only, 1 hour, protected route | `backend/test/auth.test.js` |
| Rapyd request signature (formula and headers) | `gateway/test/rapyd.test.js` (a fake Rapyd recomputes the signature) |
| Rapyd error mapping and retries (network only, new salt each try) | `gateway/test/rapyd.test.js` |
| Webhook signature check (valid, wrong, changed body, missing headers, both encodings) | `gateway/test/webhooks.test.js` |
| Webhook forwarding and retries | `gateway/test/webhooks.test.js` |
| Webhook applied once, no status change from a repeated or late event | `backend/test/reconcile.test.js` |
| Claim token: hash only, 7-day expiry, single use, one transfer at a time | `backend/test/claims.test.js` |
| Claim destination: https and an allowed host only | `backend/test/claims.test.js` |
| Email templates: escaping, no leftover placeholders, English subjects | `backend/test/email.test.js` |
| Email logs: no code, link or address | `backend/test/email.test.js` |
| Live status over WebSocket: access, tokens, timeouts | `backend/test/live-status.test.js` |
| Browser reconnect and stop rules | `backend/test/frontend-live-status.test.js` |
| API client, sandbox banner, pages, no `localStorage`, no HTML from strings | `backend/test/frontend-shell.test.js`, `backend/test/frontend-flow.test.js` |
| Full flow in one run | `backend/test/integration.test.js` |
| Lost webhook recovered by the poller | `backend/test/integration.test.js` |

## Proof that the tests catch a broken rule

The payment state table was changed on purpose to allow `claimed` → `created`. The transition test failed, and the file was then restored from a backup. The suite passed again afterwards.

## The sandbox check

`backend/scripts/sandbox-check.js` runs five steps against the real services and stops at the first failure:

1. The gateway answers `/health`.
2. The gateway refuses a checkout request without its token.
3. A sandbox checkout is created through the gateway. Rapyd rejects localhost return URLs, so `BASE_URL` must be public.
4. The checkout status reads back as `pending`.
5. The Interledger test wallet answers and reports its asset.

It creates one sandbox checkout, which nobody pays. It is not part of `npm test`, because it calls real services.

## Not covered by automated tests

- **Real Rapyd webhooks:** the signature encoding (base64 of the HMAC, or base64 of its hex) is accepted both ways until one real sandbox webhook confirms which one Rapyd sends.
- **Real transfers:** the Open Payments transfer is not written yet (prompt 08 is blocked).
- **Browser layout:** checked by hand in headless Edge at 360 px (no horizontal overflow). It is not an automated test.
- **Ping timeout:** the 10-second drop for a client that stops answering pings is in the code, but no test waits for it.
- **More than one app instance:** live updates and the poller assume a single process.
