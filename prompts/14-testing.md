# 14 — Testing

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Create the automated and manual test suites for the whole flow.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and all existing code in `backend/`, `gateway/`, and `frontend/`.

Steps:
1. Use Node's built-in test runner (`node --test`) unless a decision is recorded in `docs/DECISIONS.md` to use another. Record it there.
2. Unit tests for: payment states, OTP rules, Rapyd signature, webhook signature check, claim token rules, email templates.
3. Integration test that runs against a temporary SQLite file and mocked Rapyd and Open Payments: request code → verify → create payment → mock paid webhook → claim → mock transfer → `completed`.
4. A manual sandbox script at `backend/scripts/sandbox-check.js`. It uses real Rapyd sandbox keys and testnet wallets from `.env`. It prints each step and its result, and exits non-zero with a clear message on the first failure.
5. Add npm scripts: `test` (automated, no network) and `test:sandbox` (manual).
6. Write `docs/TESTING.md` explaining both and what each one covers.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- The automated tests must not use the network.
- Never write real secrets into any file.

Done when:
- `npm test` passes with no network connection.
- A deliberately broken rule makes at least one test fail (run it once to prove it, then restore the code).
- `npm run test:sandbox` has been run once against real sandbox keys, with the output reported. If it was not run, say so.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
