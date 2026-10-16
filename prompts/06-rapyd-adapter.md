# 06 — Rapyd adapter

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. 18/18 automated tests pass; container reached the live Rapyd sandbox and got an authentication error with placeholder keys. Real checkout not yet created (needs sandbox keys).
**Files produced:** `gateway/package.json`, `gateway/src/{config,errors,logger,app,server}.js`, `gateway/src/providers/rapyd.js`, `gateway/test/{rapyd,gateway}.test.js`; edited `docker/docker-compose.yml` (gateway bound to 127.0.0.1), `.env.example` (`RAPYD_COUNTRY`, `GATEWAY_TOKEN`), `docs/DECISIONS.md` (decision 007)

## Prompt

Build the Rapyd adapter in the gateway service. Rapyd is used only for card collection, through a checkout.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, `docs/DECISIONS.md`, and `docker/docker-compose.yml` before starting. Use the official Rapyd documentation as the reference for request signing and checkout endpoints: https://docs.rapyd.net/es/index-es.html. Check each endpoint in the docs before you write it.

Steps:
1. Create `gateway/` as a Node service with its own `package.json`, `"type": "module"`.
2. Create `gateway/src/providers/rapyd.js`, the only module that knows Rapyd field names and URLs. Export:
   - `createCheckout({ paymentId, amountCents, currency, returnUrl })`
   - `getCheckoutStatus(checkoutId)`
3. Sign every request with Rapyd's scheme: salt, timestamp, and an HMAC of method, path, salt, timestamp, access key, and body, using `RAPYD_SECRET_KEY`. Follow the documentation exactly.
4. Choose the sandbox or production base URL from `RAPYD_SANDBOX`.
5. Timeout of 10 seconds per request. Retry only network errors, up to 2 times, with backoff. Never retry 4xx responses.
6. Map Rapyd errors to internal codes such as `provider_auth_failed`, `provider_unavailable`, `provider_rejected`. Never return a raw Rapyd response.
7. Expose the gateway over HTTP:
   - `POST /checkout` (body from `createCheckout`)
   - `GET /checkout/status/:id`
   - `GET /health`
   The app calls the gateway over HTTP, not the Rapyd module directly.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real Rapyd keys into any file. Tests use mocked HTTP.
- Do not add webhook handling. That is prompt 07.

Done when:
- A unit test reproduces the signature from the documentation's example, using a fixed salt and timestamp.
- A test with a mocked 401 returns `provider_auth_failed`.
- A test with a mocked network error retries and then returns `provider_unavailable`.
- A manual check with real sandbox keys creates a checkout and returns a URL. Report the result; do not mark it passed without running it.

At the end, list every file created or changed with its full path, and the output of each "Done when" check. Say clearly which checks were run against real Rapyd and which were mocked.
