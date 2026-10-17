# 30 — Dashboard pages for wallet, requests, subscriptions, pools and history

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
