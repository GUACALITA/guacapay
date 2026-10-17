# 29 — Guided onboarding: create a test wallet and register the key

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending.
**Files produced:** `frontend/wallet-setup.html`, `frontend/js/pages/wallet-setup.js`, `frontend/config/setup.json`, `frontend/wallets.html`, `frontend/js/pages/wallets.js`, `backend/test/frontend-setup.test.js`

**Choices made in this step:**
- The official links (sign-up page, key documentation) and the link limit are in `frontend/config/setup.json`. Changing them needs no code change. Only `https` links are used.
- The steps follow `docs/OPEN_PAYMENTS.md` section 3 (sources checked 2026-10-16). Two things are not documented, and the page says so: how the key ID is formed, what the wallet shows after the key pair is generated. Registering a guacapay key in the user's wallet is not documented either, and guacapay does not do it.
- The prompt's link form (prompt 19) had no screen. The index assigns the wallet screens to prompt 30. This step adds the minimal linking page `wallets.html` (add a wallet by address, approve the link), so the setup page can lead to it. Prompt 30 may replace it.
- Approval asks for a link limit of 1000 cents (10.00 EUR of test money) from `setup.json`. Whether this is the right limit is not confirmed.
- `wallet-setup.html` has no form fields. The test checks every field in `frontend/` for password, secret and key words.

**Not verified yet:**
- The wallet's own steps, as they look on the official site today. The page follows the written documentation only.
- The approval round trip on the real test network (manual check). The approval finishes at `/api/grants/callback`, which redirects to `index.html`, not back to `wallets.html`.
- The new pages are not linked from the sign-in page yet.

## Prompt

## Prompt

Users who do not have an Interledger test wallet are guided to create one on the official site, and then to link it. The app does not create wallets or accounts on anyone's behalf. Creating a wallet needs the person's own email verification and identity steps.

Context: read `docs/OPEN_PAYMENTS.md` (the registration steps, confirmed in the documentation on 2026-10-16) and prompt 19.

Steps:
1. A page `frontend/wallet-setup.html` with numbered steps:
   1. Open the official Interledger Test Wallet sign-up page (the link is kept in config, not typed by hand).
   2. Verify your email and complete the identity steps. Only the person can do this.
   3. Create a wallet account, deposit play money, and add a wallet address.
   4. Come back here and paste the wallet address.
2. A second step shows how to register the platform key in the user's wallet: where to go in the wallet's settings, what to paste, and what the wallet shows afterwards. The steps must match the official documentation; if a step is not documented, the page says so.
3. The page links to prompt 19's linking form. It does not collect any password or code from the wallet.
4. Keep the official links in one config file so they can be changed without code changes.

Constraints:
- No automation of account creation, identity checks or wallet login. No scraping.
- The page never asks for a password, a recovery phrase or a private key.
- Everything in English. No commits.

Done when:
- A user with no wallet can follow the page to the link step without leaving the app except for the official site.
- The page contains no field for passwords, codes from the wallet, or keys.
- A test checks that no file in `frontend/` asks for a password or a private key.

At the end, list every file changed and the result of each check.
