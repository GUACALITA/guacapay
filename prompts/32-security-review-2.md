# 32 — Security review of the testnet-only flows

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
