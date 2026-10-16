# 13 — Email notifications

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
