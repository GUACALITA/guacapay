# 15 — Security review

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. All seven checks pass or are not applicable yet; two have open points (see the report). Backend 117/117, gateway 29/29. Audit: 0 vulnerabilities in production dependencies, after one high-severity fix.
**Files produced:** `docs/SECURITY_REVIEW.md`, `backend/test/security.test.js`, `.dockerignore`; edited `backend/src/app.js` (security headers), `gateway/src/app.js` (headers), `docker/app.Dockerfile` and `docker/gateway.Dockerfile` (non-root user), `backend/package.json` (nodemailer 10.1.2)

## Prompt

Review the whole repository against the security rules in `REFERENCE_ANALYSIS.md` and fix any high-severity issue found.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and `docs/DECISIONS.md` first.

Steps:
1. Search the repo for secrets: keys, tokens, passwords, `.env` content, private key headers. Check tracked and untracked files. Do not print any secret value in the report; report only the file and line.
2. Check that every API route validates its input on the server.
3. Check that webhooks verify signatures before reading the body, and that event processing is idempotent.
4. Check that OTP codes and claim tokens are stored only as hashes.
5. Check that error responses do not include stack traces, provider internals, or internal IDs in production mode.
6. Check that the Open Payments key is read from a path outside the repo and is never logged.
7. Check that `.gitignore` covers `.env`, `keys/`, and database files, and does not exclude `AI_USAGE.md` or `prompts/`.
8. Write the results in `docs/SECURITY_REVIEW.md`: each check, status (pass, fail, or not applicable), severity for fails, and the fix or the reason for leaving it.
9. Fix each high-severity fail. Report medium and low fails without fixing them, unless the fix is one line and clearly safe.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Do not print secret values, even in the report.

Done when:
- Every check in steps 1 to 7 has a status in `docs/SECURITY_REVIEW.md`.
- Every high-severity fail has a fix and a test or a manual check that shows it is fixed.

At the end, list every file created or changed with its full path, and the count of checks by status.
