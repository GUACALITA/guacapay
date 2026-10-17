# 33 — Documentation for the testnet-only product

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

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
