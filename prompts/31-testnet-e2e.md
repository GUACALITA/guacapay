# 31 — End-to-end test on the real test network

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Prove the product works on the real Interledger test network with two real test wallets, and keep a script that repeats the proof. This is the hackathon's goal: one payment working end to end.

Context: read `docs/TESTING.md`, `docs/OPEN_PAYMENTS.md` and prompts 19 to 22.

Steps:
1. A script `backend/scripts/testnet-e2e.js`, run manually (never in `npm test`). It takes two wallet addresses from `.env`: the sender and the recipient. It:
   1. Checks both public wallet documents are reachable.
   2. Checks the sender has an approved consent (grant) for transfers. If not, prints the approval link and stops.
   3. Runs a pay-by-email payment of a small amount (for example 0.10 in the wallet's asset), from the sender to custody, then from custody to the recipient.
   4. Reads each outgoing payment until it reports completed, and prints the state of each leg.
   5. Prints a summary: amount, both wallets, both transfer IDs, and the final status.
2. The script stops at the first failure, prints the step name and the reason, and never prints a key or a token.
3. Save the output of one successful run to `docs/E2E_RUN.md` (no secrets, no tokens), with the date.

Constraints:
- The script never creates wallets or accounts, and never completes a consent for anyone.
- It uses only the test network.
- Everything in English. No commits.

Done when:
- One real run completes, and its output is saved in `docs/E2E_RUN.md`.
- A run without consent stops with the approval step, and prints no secret.

**Depends on:** prompts 18 to 22, two linked test wallets, approved consent (manual), and play money in the sender's wallet (manual deposit).

At the end, list every file changed and the result of each check.
