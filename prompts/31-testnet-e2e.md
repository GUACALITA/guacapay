# 31 — End-to-end test on the real test network

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** script written and syntax-checked; **the real run has not happened**. It needs an approved consent and play money, which only the owner can provide. `docs/E2E_RUN.md` stays "pending" until one successful run is pasted in.
**Files produced:** `backend/scripts/testnet-e2e.js`, `docs/E2E_RUN.md`; edited `backend/package.json` (`e2e:testnet`, not part of `npm test`), `docs/TESTING.md` (manual row)

**Choices made in this step:**
- The script uses the app's own functions: `payFromWallet` for sender to custody, and `issueClaim`, `verifyClaimEmail` and `confirmClaim` for custody to recipient. It does not call the network directly.
- The recipient's login code comes from the script's own mailer, so the email step is not proved. Stated in `docs/E2E_RUN.md`.
- The script never creates a wallet or account, and never approves a consent. If the sender's consent is not approved, it starts one and prints the approval link, then exits with code 2.
- The script lowers the payment minimum to 1 cent unless `PAYMENT_MIN_CENTS` is set, so 0.10 can be paid.
- Exit codes: 0 completed, 1 failed at a step, 2 stopped before any money moved.
- Printed output: step names, transfer and leg states, amounts, wallet URLs and the payment ID. No tokens, codes or keys.

**Not verified yet:**
- A successful run on the test network (manual; needs approved consent and play money).
- A run without consent stopping at the approval step (needs the sender wallet linked in the app's database; the script was not run).
- Only the syntax was checked, inside a Node container, without running the script.

## Prompt

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
