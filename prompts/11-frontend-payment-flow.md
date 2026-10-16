# 11 — Frontend payment flow

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16, partly verified. Backend 86/86 automated tests pass. Served pages checked in headless Edge: sandbox banner shows, signed-out states are correct, no horizontal overflow at 360 px. **Not verified end to end:** a real sign-in (email is not configured until prompt 13), and a real sandbox payment (needs the webhook URL and sandbox keys confirmed).
**Files produced:** `frontend/index.html`, `frontend/new.html`, `frontend/payment.html` (page logic moved out of the file), `frontend/js/{money,payment-form,messages,flows}.js`, `frontend/js/pages/{login,new-payment,payment}.js`, `backend/test/frontend-flow.test.js`; edited `frontend/js/api.js` (extra headers, for `Idempotency-Key`), `frontend/css/main.css` (form, error and status styles), `backend/src/app.js` (`/api/config` also returns `currencies`), `backend/test/frontend-shell.test.js` (`/api/config` check reads `sandbox` only)

**Notes:**
- The form sends one `Idempotency-Key` per attempt, and reuses it when the same details are sent again after an error.
- A checkout that was already started sends the payer to the payment page, not to a second checkout.
- The payment page does not show the payment ID or any provider detail.
- The Rapyd return message: the status text covers it (for example, "waiting for your payment to be confirmed"). There is no separate return message yet.
- `.env` sets no `PAYMENT_CURRENCIES`, so only USD is offered. The testnet wallet is EUR, so this must be decided before a test transfer.

## Prompt

Connect the frontend pages to the backend so a sender can log in, create a payment, pay with Rapyd, and see the result.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and the current `frontend/` and `backend/` code. The API for login (prompt 04), payments (prompt 05), Rapyd checkout (prompt 06), and live status (prompt 09) must exist first.

Steps:
1. `index.html`: two-step login. Enter email, then the 6-digit code. Store the JWT in `sessionStorage`. Show a clear message for each error.
2. `new.html`: fields for recipient email, amount, currency, and an optional message. Validate in the browser (format, amount greater than zero, two decimals maximum). Send to `POST /api/payments` with an `Idempotency-Key` generated once per form submission. Disable the submit button while the request is in flight.
3. After a payment is created, call the backend endpoint that starts the Rapyd checkout, then redirect the browser to the returned checkout URL.
4. `payment.html?id=`: show the current status in plain words for each state. Subscribe to live updates with `frontend/js/live-status.js` (prompt 09). Show the Rapyd return message when the user comes back from checkout.
5. Do not show internal IDs, provider error codes, or stack traces to the user.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets or keys into any file.
- Do not add the claim flow. That is prompt 12.

Done when:
- A sandbox payment goes from the form to the Rapyd checkout and back to the status page.
- An invalid amount shows an inline message and no request is sent.
- Double-clicking submit creates one payment.
- Each state shows a readable message on `payment.html`.

At the end, list every file created or changed with its full path, and the output of each "Done when" check. Say which checks used real Rapyd sandbox and which used mocks.
