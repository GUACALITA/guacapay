# 13 — Email notifications

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. Backend 112/112 automated tests pass (7 new email tests). Checked with a real Mailpit container on a private network: the login email arrived with the right subject, recipient and six-digit code, and the logs show only the type and a recipient reference. With the mail server stopped, sign-in returns 503 `email_failed`.
**Files produced:** `backend/src/email/{render,send,index}.js`, `backend/src/email/templates/{login-code,claim-link,payment-confirmation}.{txt,html}`, `backend/test/email.test.js`; edited `backend/src/config.js` (`smtp`), `backend/src/auth/mailer.js` (`sendPaymentConfirmation`), `backend/src/claims/service.js` (amount in claim email, sender confirmation), `backend/src/claims/routes.js`, `backend/src/server.js` (real mailer), `frontend/js/messages.js` (`email_failed`), `docker/docker-compose.yml` (SMTP to the mail catcher), `.env.example` (`SMTP_FROM`), `docs/DECISIONS.md` (decision 013), `backend/package.json` (nodemailer)

**Notes:**
- The mail catcher in the compose file (Mailpit) receives mail on port 1025 inside the network; its web view is on 8026 as specified.
- The sign-in code is now delivered. Sign-in can be completed end to end in development, and the claim email is sent when a payment is paid.

## Prompt

Send the three emails the app needs and connect them to the flows that already exist.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and the current `backend/` code. Replace the stub `sendLoginCode` from prompt 04 with the real module.

Steps:
1. Create `backend/src/email/` with:
   - `transport.js`: one SMTP transport built from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.
   - `templates/`: one plain-text file and one HTML file per email type.
   - `send.js`: one function per email: `sendLoginCode`, `sendClaimLink`, `sendPaymentConfirmation`.
2. Each email has a subject in English, a short explanation, and the action or code. The footer says the message was sent by guacapay and that the recipient can ignore it if they did not expect it.
3. In development, `SMTP_HOST` points to the mail catcher service from prompt 01, so no real email is sent.
4. Log only the email type, a hash of the recipient address, and the result. Never log the code, the token, or the message body.
5. If sending fails, the caller gets a clear error. Login retries are not automatic; the user can request a new code.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real SMTP credentials into any file.

Done when:
- All three emails appear in the mail catcher UI at `http://localhost:8026`.
- The logs contain the type and a recipient hash, but no code or token.
- Stopping the mail catcher makes the login request return a clear error, not a crash.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
