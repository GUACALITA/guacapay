# Open Payments on the Interledger test network

**Scope (decision 017):** this is the only money rail in the product. Money moves between test wallets, in play money, and cannot be converted to cash.

**Rule for this file:** a fact is listed under "Verified" only with the date it was checked and the source. Anything else is "Not yet verified". Nothing here has been checked against a real transfer yet; the first real transfer is the one in `E2E_RUN.md`.

## Verified facts

| # | Fact | Date checked | Source |
|---|---|---|---|
| V1 | The sign-up site is `https://wallet.interledger-test.dev` (Interledger Test Wallet, play money). | 2026-10-16 | https://openpayments.dev/sdk/before-you-begin/ |
| V2 | The environment runs on a GateHub pre-production system that mimics production. | 2026-10-16 | https://openpayments.dev/sdk/before-you-begin/ |
| V3 | Account steps: create an account and confirm the email (subject "[Test.Wallet] Verify your account"); complete KYC (only a real email is needed); create a wallet account and choose an asset; deposit play money from the account page; add a wallet address with a wallet address name and a public name. | 2026-10-16 | https://openpayments.dev/sdk/before-you-begin/ |
| V4 | Keys: in Settings, open Developer Keys, expand the wallet account, and generate a key pair. A `private.key` file downloads, and the key ID appears on screen. | 2026-10-16 | https://openpayments.dev/sdk/wallet-get-keys/ |
| V5 | Wallet address format: `https://ilp.interledger-test.dev/<id>`. The sign-up site (`wallet.interledger-test.dev`) and the address host (`ilp.interledger-test.dev`) differ; both are on the same test network. | 2026-10-16 | https://openpayments.dev/sdk/before-you-begin/ and the wallet address itself |
| V7 | The Open Payments private key file parses as an Ed25519 key (checked locally; no network involved). | 2026-10-16 | Local check of the key file, outside the repository |
| V6 | The sender wallet document is public: it answers HTTP 200 without credentials, with asset code `EUR`, asset scale 2, an authorization server on `auth.interledger-test.dev`, and a resource server on `ilp.interledger-test.dev`. | 2026-10-16 | https://ilp.interledger-test.dev/71dd8185 (the platform's sender wallet, public document) |

## Not yet verified

| # | Item | Why it matters | How to settle it |
|---|---|---|---|
| N1 | The receiver wallet: a second wallet address, linked to the test network | Needed for the first real transfer | The user creates one on the official site and gives its address (the app does not create it) |
| N2 | Testnet limits: rate limits, transaction caps, account quotas, expiry | The test amounts | Check in the test wallet, or ask the Interledger team |
| N3 | The format of the `interval` in a grant's limits (the app sends `R/<start>/<duration>`, duration `P1D`, `P1W` or `P1M`) | Subscriptions and tandas (decisions 024, 025, 026) | On 2026-10-17 a web search and the docs at `openpayments.dev/identity/grants/` did not show it, and the specification file on GitHub returned 404. Read the current auth-server specification and record the source here. |
| N4 | Whether a receiver's incoming-payment permission is granted without any user step | The transfer engine refuses with `receiver_interaction_required` if it is not | The first real transfer |
| N5 | The state values an outgoing payment reports (the app compares upper-case `COMPLETED` and `FAILED`) | Ends each transfer | The first real transfer; read the state field of a real outgoing payment |
| N6 | That a quote permission is granted without a user step | Each transfer makes a quote | Reported during development, no recorded date or source. Re-check with a real grant request. |
| N7 | That an outgoing-payment permission needs one approval on the wallet's page | The consent flow depends on it | Reported during development, no recorded date or source. Re-check with a real consent. |
| N8 | That the test wallet document has no balance field the app can read | Reconciliation of custody (decision 018) reports `not_available_from_api` | Reported during development, no recorded date or source. Re-check against a real wallet document. |
| N9 | What the wallet shows after the key pair is generated, beyond the key ID | The onboarding page says it is not documented | Not documented |
| N10 | How the key ID is formed | Shown on the onboarding page as not documented | Not documented. The sender wallet's key ID is already in `.env`. |
| N11 | Whether the platform's key must be registered in a user's wallet | Onboarding step 2 | Design (decision 028): the user never handles a key. The app signs its requests with the platform's own key, which belongs to the platform's wallet address (`OPEN_PAYMENTS_WALLET_ADDRESS`). The user only pastes their wallet address and approves the link in their own wallet. Whether a user's wallet accepts that client without any registration is not verified; check on the first real consent. |
| N12 | A remote revocation call for a permission | Revoking a permission is currently local only (`SECURITY_REVIEW.md`, F11) | Read the current Open Payments specification for a revocation endpoint |
| N13 | Whether a grant with no expiry time ever expires | Expiry handling (`SECURITY_REVIEW.md`, F15) | Confirm with a real grant |
| N14 | The currency of the test wallets against the app's default | The app's default accepted currency is USD; the sender wallet is EUR. Payments must use the wallet's currency. | Set `PAYMENT_CURRENCIES=EUR` (already the setting for the test wallets). Confirm with the test wallets. |

## Where the keys live

| Value | `.env` variable | Location |
|---|---|---|
| Sender wallet URL | `OPEN_PAYMENTS_WALLET_ADDRESS` | `.env` (git-ignored) |
| Key ID | `OPEN_PAYMENTS_KEY_ID` | `.env` (git-ignored) |
| Ed25519 private key (PKCS8 PEM) | `OPEN_PAYMENTS_PRIVATE_KEY_PATH` | outside the repository |
| Custody wallet ID and address | `CUSTODY_WALLET_ID`, `CUSTODY_WALLET_ADDRESS` | `.env` (git-ignored) |
| Hosts the server may call | `OPEN_PAYMENTS_HOSTS` (default: the two test-network hosts) | `.env` (optional) |

The key file must be reachable inside the app container. `docker/docker-compose.yml` still mounts `keys/` from the repository (`SECURITY_REVIEW.md`, F6). Do not send the key file or its contents anywhere. Send only wallet URLs and the key ID.

## Recurring grants: interval format (not verified)

The code validates intervals with the pattern `^R\/[^/]+\/P[^/]+$` (`backend/src/grants/service.js`), and sends `R/<start>/<duration>`. That is the ISO 8601 repeating form, but the form the authorization server expects is not verified (N3). Until it is, subscriptions and tandas are "written, not run", and the interval is the first thing to check against a real consent.

## Open design question (resolved)

Who holds the money between payer and recipient: the platform's custody wallet, configured by `CUSTODY_WALLET_ID` and `CUSTODY_WALLET_ADDRESS`. Decision 018 and 019 record it.
