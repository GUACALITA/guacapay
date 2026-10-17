# Prompts

Every prompt used to build or change this project is saved here, one file per step, and listed in `AI_USAGE.md`.

**Status of the list:** prompts 00 to 16 were the first build (Rapyd collection, claims, email). Prompts 17 onward rebuild the product around **Open Payments on the Interledger test network only**, as agreed on 2026-10-17: wallets are the accounts, the user signs in with email, links the wallet once with consent, and every money movement goes through Open Payments. Rapyd is removed from the money path.

## Conventions

- File name: `NN-topic.md`, numbered in the order below.
- Each prompt file contains: the exact prompt text, the date, the tool and model used, and the files it produced.
- Prompts and documentation are in English.
- Every prompt ends with a "Done when" check that can be verified by running something or reading a file.
- No prompt commits to git, and no prompt mentions another project by name.

## Earlier build (00 to 16)

| # | File | Topic | Status |
|---|---|---|---|
| 00 | `00-project-setup.md` | Repo layout and conventions | executed |
| 01 | `01-docker-compose.md` | Compose stack | executed |
| 02 | `02-backend-core.md` | Express core, config, errors | executed |
| 03 | `03-backend-database.md` | SQLite schema and migrations | executed |
| 04 | `04-backend-auth-otp.md` | Email code sign-in | executed |
| 05 | `05-backend-payments.md` | Payment states and idempotency | executed |
| 06 | `06-rapyd-adapter.md` | Rapyd checkout adapter (gateway) | executed; **no longer on the money path** |
| 07 | `07-rapyd-webhooks.md` | Rapyd webhooks and polling | executed; **no longer on the money path** |
| 08 | `08-openpayments-testnet.md` | Open Payments testnet | blocked; **superseded by 18 to 22** |
| 09 | `09-websocket.md` | Live status | executed |
| 10 | `10-frontend-shell.md` | Frontend pages | executed |
| 11 | `11-frontend-payment-flow.md` | Payment pages | executed |
| 12 | `12-claim-flow.md` | Claim flow | executed; transfer step to be replaced by 22 |
| 13 | `13-email-notifications.md` | Email | executed |
| 14 | `14-testing.md` | Test suites and sandbox check | executed |
| 15 | `15-security-review.md` | Security review | executed |
| 16 | `16-docs.md` | Documentation | executed |

## Testnet-only product (17 onward)

Priority order. Items marked **demo** are needed for the hackathon's goal: one payment working end to end.

| # | File | Topic | Priority |
|---|---|---|---|
| 17 | `17-scope-testnet-only.md` | Remove Rapyd from the money path and record the new scope | first |
| 18 | `18-openpayments-client.md` | Open Payments client wrapper and wallet lookup | **demo** |
| 19 | `19-wallet-link.md` | Link a user's test wallet once, with consent | **demo** |
| 20 | `20-grants-and-consent.md` | Grants: create, finish, reuse, limits and intervals | **demo** |
| 21 | `21-transfer-engine.md` | Transfers as legs: quote, incoming, outgoing, confirmation | **demo** |
| 22 | `22-payment-flow-testnet.md` | Pay by email: sender to custody, claim, custody to recipient | **demo** |
| 23 | `23-custody-wallet.md` | The platform custody wallet and its ledger | **demo** |
| 24 | `24-payment-request-qr.md` | Payment requests and QR codes | feature |
| 25 | `25-recurring-charges.md` | Subscriptions and recurring charges | feature |
| 26 | `26-tandas-collections.md` | Group pools (tandas and collections) | feature |
| 27 | `27-split-payments.md` | One payment to several recipients | feature |
| 28 | `28-withdraw-to-wallet.md` | Move balance to the user's own wallet | feature |
| 29 | `29-onboarding-guidance.md` | Guided steps to create a test wallet and register the key | **demo** |
| 30 | `30-dashboard-frontend.md` | Pages for wallet, requests, subscriptions, pools, history | feature |
| 31 | `31-testnet-e2e.md` | End-to-end test with two real test wallets (manual) | **demo** |
| 32 | `32-security-review-2.md` | Security review of the new flows | before demo |
| 33 | `33-docs-update.md` | README, architecture and decisions for the new scope | before demo |

**Status of 17 to 33 (2026-10-17):** every prompt's code is written and recorded in `AI_USAGE.md`. The automated tests for prompts 18 to 32 are written and **have not been run**, at the owner's request. No transfer has been made on the real test network: the first real run is prompt 31's script (see `docs/E2E_RUN.md`), and it needs an approved consent and play money from the owner.
