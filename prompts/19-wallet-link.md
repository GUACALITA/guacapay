# 19 — Link a user's test wallet once

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code written; tests written but **not run**, at the user's request. Verification is pending.
**Files produced:** `backend/migrations/005-wallets.sql`, `backend/src/wallets/service.js`, `backend/src/wallets/routes.js`, `backend/test/wallets.test.js`; edited `backend/src/app.js` (mounts `/api/wallets`, accepts an optional `walletReader` for tests)

**Not done in this step:**
- The frontend "My wallet" page. The setup guidance and the form belong to prompts 29 and 30.
- The consent step. The wallet stays `pending` until prompt 20 calls `markWalletLinked`.
- Revoking a wallet does not yet revoke its grants; prompt 20 adds that.

**Verification pending:** run `npm test` in `backend/`. Expected: the new `wallets.test.js` cases (add, list, duplicate, `wallet_in_use`, owner-only revoke, relink after revoke, consent-only linking, https-only, sign-in required).

## Prompt

After sign-in with email, a user links their Interledger test wallet. The app records which wallet belongs to which user, and it requests consent from that wallet once.

Context: read prompts 18 and 20, `docs/OPEN_PAYMENTS.md`, and the current `backend/src/auth/` code.

Flow the user sees:
1. Signed in with email, the user opens "My wallet".
2. They paste their wallet address (for example `https://ilp.interledger-test.dev/<id>`).
3. The app reads the public wallet document and shows the asset (for example EUR) and the wallet ID.
4. The app shows the steps to register the platform key in that wallet (prompt 29 holds the wording). Until the key is registered, linking cannot finish.
5. The user confirms. The app starts consent (prompt 20) and shows the approval link.
6. When consent completes, the wallet is `linked`.

Steps:
1. Migration `backend/migrations/005-wallets.sql`: table `wallets` with `id`, `user_id`, `wallet_url` (unique per user and per URL), `asset_code`, `asset_scale`, `status` (`pending`, `linked`, `revoked`), `created_at`, `linked_at`.
2. `backend/src/wallets/service.js`: add a wallet (validates the URL, one wallet per URL), list wallets, mark linked, revoke.
3. Routes under `/api/wallets`: `POST /`, `GET /`, `POST /:id/revoke`. Only the owner can see or change a wallet; other users get 404.
4. Reject a wallet URL that is already linked to another user, with `wallet_in_use`.

Constraints:
- No wallet secret is stored. The wallet URL and its public document are the only data kept.
- Tests use the fake Open Payments server from prompt 18.
- Everything in English. No commits.

Done when:
- A user can add a wallet, see it, and revoke it.
- Another user cannot see or revoke it (404).
- A URL linked to one user is refused for another user (`wallet_in_use`).
- A wallet stays `pending` until consent completes (prompt 20).

**Depends on:** the platform key being registered in the user's wallet (manual step, prompt 29).

At the end, list every file changed and the result of each check.
