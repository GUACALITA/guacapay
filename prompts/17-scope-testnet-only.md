# 17 — Scope: testnet only, Rapyd out of the money path

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-17. Backend 126/126 and gateway 29/29 pass with networking disabled. The running app returns `rail_not_available` for a card recharge by default.
**Files produced:** `backend/src/rails.js`, `backend/test/rails.test.js`; edited `backend/src/config.js` (`PAYMENT_RAILS`, default `openpayments`), `backend/src/payments/routes.js` and `backend/src/balance/routes.js` (card routes guarded), `backend/test/{reconcile,integration,balance}.test.js` (set `PAYMENT_RAILS=rapyd` where the card path is tested), `docs/DECISIONS.md` (015 marked partly superseded, 016 marked superseded, 017 added and the order fixed), `docs/ARCHITECTURE.md`, `docs/OPEN_PAYMENTS.md`, `README.md`, `.env.example`

**Note:** `.env.example` was found holding real-looking values in the local commit `7c496ae`, which is not pushed. It was restored to variable names only. The commit must be amended before pushing.

## Prompt

Change the product scope to testnet only, using Open Payments as the only money rail. Rapyd stays in the repository but is taken out of every money path, and the decisions are recorded.

Context: read `REFERENCE_ANALYSIS.md`, `docs/DECISIONS.md` (decisions 015 and 016), `docs/OPEN_PAYMENTS.md`, and `prompts/README.md` before starting.

Agreed scope:
- Users sign in with email. Their Open Payments test wallet is linked once, with consent.
- Every movement of money goes through Open Payments between test wallets.
- No own Interledger node, no Rafiki, no Guacalita, no Chimoney.
- No cash-out. Balances stay inside the test network.
- Rapyd is not used to collect or pay out money in this scope.

Steps:
1. Add decision 017 to `docs/DECISIONS.md`: the testnet-only scope, why Rapyd leaves the money path, and what is ruled out. Do not renumber older decisions.
2. Disable Rapyd collection in the runtime with one config switch (`PAYMENT_RAILS=openpayments`). When the switch is set, `POST /api/balance/recharges` and the Rapyd checkout route return `rail_not_available` with a clear message. Do not delete the gateway code yet.
3. Keep the Rapyd code and its tests passing, so the work can be restored if the scope changes.
4. Update `README.md`, `docs/ARCHITECTURE.md` and `docs/OPEN_PAYMENTS.md` to describe the new scope. Mark Rapyd as "kept, not in the money path".

Constraints:
- Build from scratch in this repository. Do not copy code, configuration or files from any other repository.
- Everything in English. No commits, branches or resets.
- Never write real secrets into any file.

Done when:
- With `PAYMENT_RAILS=openpayments`, a recharge request returns `rail_not_available` and creates no payment.
- All existing backend and gateway tests still pass, with networking disabled.
- Decision 017 exists, and the README no longer says Rapyd collects the money.

At the end, list every file changed with its full path and the result of each check.
