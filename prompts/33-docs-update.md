# 33 — Documentation for the testnet-only product

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** documentation written. The "Done when" check on claims is **not met as written**: every claim names a check, but the checks are written and not run, and no real-network transfer has happened. Those claims are marked "not verified". Tests not run, at the owner's request.
**Files produced:** `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (018 to 031), `docs/OPEN_PAYMENTS.md`, `docs/TESTING.md`, `prompts/README.md` (status note), `AI_USAGE.md`, `prompts/33-docs-update.md`

**Choices made in this step:**
- Every claim in the README names its test, marked "written, not run". No claim is presented as passing.
- `OPEN_PAYMENTS.md` lists facts with dates and sources only when the repository records them. Facts reported during development without a recorded date are "not yet verified" (N6 to N8) until re-checked.
- Decisions 018 to 031 each have a reason and what they rule out. Decisions 007, 008 and 015 get a status note; 016 was already superseded; 017 gets a note about the later withdrawal rule.
- Stale claims corrected: the testing doc said the dashboard's 360 px layout was checked by hand (it was not); the AI usage summary said every check passed (it did not).

**Rapyd search (criterion):** every mention of Rapyd in `README.md`, `docs/`, `prompts/README.md` and `AI_USAGE.md` is either the card path (development, `PAYMENT_RAILS=rapyd`), a note that it is off the money path, or a superseded decision. `docs/SECURITY_REVIEW.md` is excluded from the search because it is a findings record.

**Claims not yet verified:**
- Every money flow on the real test network (pay by email, requests, subscriptions, pools, splits, deposits and withdrawals).
- The interval format for subscriptions and tandas (N3).
- The outgoing payment's state values and the receiver's permission behavior (N4, N5).
- The 360 px layout of the dashboard and the onboarding pages.
- The test wallets' currency against the app's default (N14).

## Prompt

## Prompt

Update the documentation so that it describes the product as it now is, with nothing described as working unless a check shows it.

Context: read every file in `docs/`, `prompts/README.md`, `AI_USAGE.md`, and the current code, before writing.

Steps:
1. `README.md`: what the product does (pay by email with test wallets, requests and QR, subscriptions, tandas, splits, withdrawal to own wallet), what a user needs (a test wallet they create on the official site), and how to run it. Remove any claim that Rapyd moves the money.
2. `docs/ARCHITECTURE.md`: the two-transfer flow, the custody wallet, the legs, and the grant lifecycle. Keep the Rapyd gateway described as kept but not in the money path.
3. `docs/DECISIONS.md`: one entry per new decision (017 onward), each with its reason and what it rules out.
4. `docs/OPEN_PAYMENTS.md`: every fact verified on the test network, with the date and the source, and every open item.
5. `docs/TESTING.md`: the new suites and the testnet end-to-end script (prompt 31).
6. `AI_USAGE.md`: one row for each prompt executed from 17 onward.
7. Mark anything not verified on the real network as "not yet verified".

Constraints:
- Everything in English. No commits.
- Do not mention any other project by name.
- Never write real secrets into any file.

Done when:
- Every claim in the README is backed by a passed check or a link to one.
- `docs/OPEN_PAYMENTS.md` lists each verified fact with its date and source.
- A search of the docs for "Rapyd" finds only the places that say it is out of the money path.

At the end, list every file changed and any claim that is not yet verified.
