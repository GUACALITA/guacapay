# 32 — Security review of the testnet-only flows

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** review done and recorded; one high finding fixed (F9) with a regression test written but **not run**; one high finding (F10) **open and needs the owner** (credentials in shared history). Tests not run, at the owner's request.
**Files produced:** `docs/SECURITY_REVIEW.md` (new section for prompt 32); `backend/test/security-review.test.js`; edited `backend/src/providers/openpayments.js` (`assertAllowedHost` before every Open Payments call), `backend/src/config.js` (`openPaymentsHosts`), `.env.example` (`OPEN_PAYMENTS_HOSTS`, name only)

**Choices made in this step:**
- Fixed F9 (server contacts user-chosen hosts) by an allow-list in configuration, checked before any request. Only `allowHttp`, which tests use with a local server, skips it.
- Did not fix F10 (commit `7c496ae` with example values is in `origin/main`). Rewriting shared history is destructive and needs the owner's decision; the values need rotation either way.
- Did not change git state. Read-only commands only.
- Dependency audit run inside Node containers from the lockfile, so `node_modules` on this machine was not touched.

**Not verified yet:**
- The regression test for F9 (not run).
- The remaining open findings (F10 to F15) are recorded in `docs/SECURITY_REVIEW.md` with their owners' actions.

## Prompt

## Prompt

Review the new flows (prompts 17 to 31) against the rules in `docs/SECURITY_REVIEW.md`, and fix any high-severity finding.

Context: read `docs/SECURITY_REVIEW.md` first, then the new migrations and services.

Check, and record each result in `docs/SECURITY_REVIEW.md` as a new section:
1. Grants and tokens: stored encrypted, never logged, revoked on request, and expired grants are refused.
2. Consent callback: the nonce is checked, and a callback cannot be replayed.
3. Wallet ownership: a user cannot read or act on another user's wallet, grant, subscription, pool or request.
4. Money rules: no transfer without a linked wallet and consent; no payout above custody; no double charge for one period; no double contribution for one period.
5. Input validation on every new route, including amounts in the wallet's asset scale.
6. Public pages (request links, wallet setup) show no wallet URL, email, token or internal ID.
7. Custody wallet keys and the custody balance are never exposed to users.
8. Dependencies: `npm audit --omit=dev` on backend and gateway, with any new package checked.
9. The rule "no secret in tracked files or history" still holds.

Constraints:
- Fix each high-severity finding, with a test or a manual check that shows it is fixed.
- Do not print secret values, even in the report.
- Everything in English. No commits.

Done when:
- Every check above has a status in `docs/SECURITY_REVIEW.md`.
- Every high-severity finding is fixed and shown fixed.

At the end, list every file changed, and the count of checks by status.
