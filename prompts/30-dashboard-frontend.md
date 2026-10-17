# 30 — Dashboard pages for wallet, requests, subscriptions, pools and history

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** code and tests written; **tests not run**, at the user's request. Verification is pending. The 360 px check in headless Edge has not been run.
**Files produced:** `frontend/dashboard.html`, `frontend/js/pages/dashboard.js`, `backend/test/frontend-dashboard.test.js`; edited `frontend/js/messages.js` (status texts for requests, subscriptions, pools, deposits and withdrawals; role and interval labels), `frontend/css/main.css` (wrapping and image rules for 360 px), `backend/src/subscriptions/service.js` (the list says whether the user is the payee or the payer), `backend/test/security.test.js` and `backend/test/frontend-shell.test.js` (dashboard added to the inline-style checks)

**Choices made in this step:**
- Each section loads on its own, shows its own empty state with one action, and its own error. A rejected session ends the page and shows sign-in.
- The history is built on the client from payments, withdrawals and deposits, newest first. There is no combined history endpoint.
- "Waiting to be claimed" is the sum of the user's payments in `claimable` status, per currency. It is not a custody balance.
- The request form creates a request from a linked wallet. The QR image is shown only if it is a PNG data URL, and the link is shown once, as the backend returns it.
- Creating subscription offers and pools has no form yet; those sections say "coming soon" and list what exists.
- No section shows an internal ID. Buttons use IDs only inside handlers.

**Not built (not in this prompt's list):**
- Deposit, withdrawal, split and join screens. The API exists; the dashboard does not link to them yet.
- The payer's page for a request, a subscription offer and a pool join link. The links these forms create point to pages that do not exist yet. The request link is shown with a note rather than as a clickable link.

**Not verified yet:**
- All sections loading with an empty account (needs a browser).
- No horizontal scroll at 360 px in headless Edge (reported separately; not run).

## Prompt

## Prompt

One signed-in home page that shows what the user can do: their wallet, their money, and the features from prompts 24 to 28.

Context: read the existing frontend (prompts 10 and 11), prompts 19 to 28, and `frontend/js/api.js`.

Steps:
1. `frontend/dashboard.html` with sections: My wallet (status, asset, link or unlink), My money (app balance and what is held for pending claims), Send (link to the payment form), Requests (create, list, share QR), Subscriptions (offers I sent, subscriptions I pay), Pools (tandas and collections), History (payments and transfers, newest first).
2. Each section loads its own data through `api.js` and shows an empty state with one clear action.
3. Every status uses the plain-language texts in `frontend/js/messages.js`. Internal IDs are never shown; amounts always show the currency.
4. Layout: one column at 360 px, no horizontal scroll, as in prompt 10.

Constraints:
- No `innerHTML` with server text; no inline styles; no `localStorage`.
- Empty and error states are shown for every section.
- Everything in English. No commits.

Done when:
- All sections load with an empty account and show their empty state.
- The page passes the existing frontend checks (no inline scripts or styles, no `localStorage`, no HTML from strings).
- Headless Edge at 360 px shows no horizontal overflow (reported).

**Depends on:** prompts 19, 24 to 28 for their sections; sections without a finished feature show "coming soon".

At the end, list every file changed and the result of each check.
