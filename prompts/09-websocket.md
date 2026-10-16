# 09 — WebSocket (live status)

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. Backend 55/55 automated tests pass (9 new, including 2 browser-module tests). Container checked: `/health` 200, and a real WebSocket client without a token is refused with 1008.
**Files produced:** `backend/src/ws/live-status.js`, `backend/src/payments/events.js`, `backend/test/live-status.test.js`, `backend/test/frontend-live-status.test.js`, `frontend/js/live-status.js`; edited `backend/src/payments/service.js` (publishes after commit), `backend/src/auth/tokens.js` (`verifyTokenPayload`), `backend/src/server.js` (HTTP server with WebSocket), `backend/package.json` (`ws`), `docs/DECISIONS.md` (decision 010)

**Notes:**
- Updates use an in-process event emitter, not polling. It works for one app instance only.
- The ping timeout (10 s) and the auth timeout are in code, but the test covers only the ping schedule and the auth timeout with shorter values. The full ping-timeout path is not tested directly.

## Prompt

Send live payment status updates to the browser over WebSocket.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and the current `backend/` code. The `payment_events` table is the source of updates (prompt 03). Authentication reuses the JWT from prompt 04.

Steps:
1. Add a WebSocket server to the app on the same port, path `/ws`, using the `ws` package.
2. The client sends `{ "type": "subscribe", "paymentId": "<id>", "token": "<jwt>" }` as its first message. The server validates the token and checks the payment belongs to that user.
3. When a new `payment_events` row is written for a subscribed payment, send `{ "type": "payment.updated", "paymentId", "status", "at" }` to that subscriber only.
4. Send a ping every 30 seconds. Close connections that do not answer within 10 seconds.
5. Create `frontend/js/live-status.js`. It connects, subscribes, reconnects with backoff, and calls a callback on each update.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never send the token back to the browser or log it.
- Do not add UI pages beyond the one script. Pages are prompts 10 and 11.

Done when:
- With two browser tabs open on the same payment, a status change in the database shows in both within 1 second.
- A subscription to another user's payment returns an error message and no data.
- A connection without a valid token is closed.
- The client reconnects after the server restarts.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
