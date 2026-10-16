# 07 — Rapyd webhooks

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. Gateway 29/29 and backend 40/40 automated tests pass. Two containers checked: a signed webhook gets 200 and reaches the app; a forged one gets 401. Not yet checked against a real Rapyd webhook.
**Files produced:** `gateway/src/{forward,config,app,server}.js`, `gateway/src/providers/rapyd.js` (webhook functions), `gateway/test/webhooks.test.js`; `backend/migrations/003-processed-events.sql`, `backend/src/{gateway-client,config,app,server}.js`, `backend/src/auth/gateway-token.js`, `backend/src/payments/{checkout,reconcile,poller,routes}.js`, `backend/test/reconcile.test.js`; updated the earlier backend tests (gateway token in env, migration list); `docker/docker-compose.yml` (service URLs); `.env.example`; `docs/DECISIONS.md` (decision 008)

**Deviations from the prompt, all recorded in decision 008:**
- The shared secret is `GATEWAY_TOKEN`, not `HMAC_SECRET`, so the gateway never holds the secret that protects stored codes.
- Events are matched by `merchant_reference_id`, and the status always comes from a checkout status request.
- `POST /api/payments/:id/checkout` was added here, because the flow cannot be tested without it. It was planned for prompt 11.

## Prompt

Receive Rapyd payment events and move payments to `paid` exactly once.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, `docs/DECISIONS.md`, and the current `gateway/` and `backend/` code. Check the Rapyd webhook signature rules in the official documentation before writing verification: https://docs.rapyd.net/es/index-es.html.

Steps:
1. In the gateway, add `POST /webhooks/rapyd`. Verify the signature using the documented method before parsing the body. If it fails, return 401 and do nothing else.
2. Map the event to a checkout ID. Unknown IDs are logged as a warning and acknowledged with 200, so Rapyd does not retry forever.
3. The gateway forwards a normalized event to the app over HTTP: `{ checkoutId, status, eventId }`. The app endpoint is `POST /internal/payment-events`, reachable only from the gateway, protected by a shared secret from `HMAC_SECRET`.
4. In the app, apply the change to `paid` only when the payment is `awaiting_payment`. Store the `eventId` so the same event is never applied twice.
5. Polling fallback: in the app, a job runs every 60 seconds. It finds payments in `awaiting_payment` older than 2 minutes and calls the gateway's `GET /checkout/status/:id`. It applies the same rules as the webhook.
6. Respond to the webhook within a few seconds. Do the processing in the same request only if it is fast; otherwise queue it in memory and log failures.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets into any file.

Done when:
- A webhook with a bad signature returns 401 and changes no rows.
- The same paid event sent twice leaves one `paid` event in `payment_events`.
- A payment still `awaiting_payment` after the webhook is blocked is marked `paid` by the poller.
- An unknown checkout ID returns 200 and writes a warning log.
- Tests for each rule above pass, using mocked Rapyd signatures.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
