# 08 — Open Payments on Interledger testnet

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** partially executed 2026-10-16, **blocked** at step 1. Two of four questions answered (provider and URL, registration steps). Missing: wallet address URL format and sender/receiver wallets (needs your accounts), testnet limits (not documented). No code written, as the prompt requires.
**Files produced:** `docs/OPEN_PAYMENTS.md`

## Prompt

Add the transfer leg: move money to the recipient's wallet on the Interledger testnet using Open Payments. Do not run any node of our own. Do not use Rafiki.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and `docs/DECISIONS.md`. Use the official Open Payments and Interledger documentation as the reference, and check the testnet wallet URLs and registration steps there before writing code.

Steps:
1. Before any code, confirm and write in `docs/OPEN_PAYMENTS.md`:
   - Which testnet wallet provider to use.
   - The URL of the sender wallet and of a test receiver wallet.
   - How to register a wallet and get a key ID.
   - Any rate or amount limits on testnet.
   If any answer is not in the documentation, stop and report it. Do not guess.
2. Create `backend/src/providers/openpayments.js`, the only module that imports `@interledger/open-payments`. Export:
   - `getWalletAddress(url)`
   - `createIncomingPayment(receiverWallet, amount)`
   - `createQuote(senderWallet, incomingPaymentUrl)`
   - `createOutgoingPayment(senderWallet, quoteUrl)`
   - `getOutgoingPaymentStatus(url)`
3. Load the Ed25519 private key from the file path in `OPEN_PAYMENTS_PRIVATE_KEY_PATH`. The file lives outside the repo. Read it once at startup and fail if it is missing.
4. Store the grant and payment URLs on the payment record. Add the columns through a new migration `backend/migrations/002-openpayments.sql`.
5. Never log the private key, grant tokens, or full wallet responses.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Do not create or store any private key in the repo.
- Do not add the claim flow. That is prompt 12.

Done when:
- `getWalletAddress` returns the testnet sender and receiver addresses (manual check, report the output).
- A test transfer between the two testnet wallets reaches `COMPLETED` (manual check, report the status).
- A grep of the repo for the key file's contents finds nothing.
- `docs/OPEN_PAYMENTS.md` answers all four questions in step 1.

At the end, list every file created or changed with its full path, and the output of each "Done when" check. Say clearly which checks were run against the live testnet and which were not run.
