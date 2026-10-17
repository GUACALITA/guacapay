# 18 — Open Payments client wrapper and wallet lookup

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-17. Backend 134/134 pass with networking disabled, including 9 new client tests (none skipped). Manual check: the sender wallet's public document was read from inside the container through the new module (EUR, scale 2, both servers present), with no key sent.
**Files produced:** `backend/src/providers/openpayments.js` (the only file that imports the SDK), `backend/test/openpayments.test.js`; edited `backend/src/config.js` (`openPayments` block, optional at startup), `.env.example` (`OPEN_PAYMENTS_RECEIVER_WALLET_ADDRESS`, names only)

**Deviations from the prompt:**
- The configuration is optional at startup. The client reports missing values when it is used, so the app still starts without them.
- `resetClient()` was added for tests and for a key change.
- `getWalletAddress` accepts `allowHttp` only for tests that reach a local fake server. Production calls always require https.

**Not verified yet:** the retry on a real network error, which is tested only against a closed local port.

## Prompt

Create the one module in the app that talks to Open Payments. Everything else uses this module.

Context: read `docs/OPEN_PAYMENTS.md`, `docs/DECISIONS.md`, and the current `backend/src/config.js`. The SDK `@interledger/open-payments` is already in `backend/package.json` (version 7.x). The sender wallet and its key ID are in `.env`; the private key file is outside the repository.

Steps:
1. Create `backend/src/providers/openpayments.js`, the only file that imports `@interledger/open-payments`. It exports:
   - `getClient()`: creates the authenticated client once, from `OPEN_PAYMENTS_WALLET_ADDRESS`, `OPEN_PAYMENTS_KEY_ID` and the key file at `OPEN_PAYMENTS_PRIVATE_KEY_PATH`. Fails at startup with a message that names the missing variable, never the value.
   - `getWalletAddress(url)`: returns the wallet document (id, assetCode, assetScale, authServer, resourceServer). Rejects a URL that is not `https`.
   - `publicWalletCheck(url)`: a plain HTTP read of the public wallet document, with no keys, used before linking.
2. Add `OPEN_PAYMENTS_RECEIVER_WALLET_ADDRESS` as an optional variable for tests, documented in `.env.example`.
3. Every SDK error becomes an `AppError` with a stable code (`wallet_not_found`, `openpayments_unavailable`, `openpayments_rejected`). The SDK message is logged, not returned.
4. Add retry for network errors only, twice, with a short delay. Never retry a rejected request.

Constraints:
- The private key is read from its file once, and never logged or returned.
- Tests use a fake HTTP server that answers the wallet document route, so no network is needed.
- Everything in English. No commits.

Done when:
- A test loads the client with a placeholder key and reads a wallet document from the fake server.
- A test shows a missing key file produces an error that names the variable, not its contents.
- A grep of the repository finds no private key material.
- The public wallet document of the sender wallet can be read in the container (manual check, reported).

At the end, list every file changed and the result of each check.
