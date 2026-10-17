# Open Payments on the Interledger test network

**Scope (decision 017):** this is the only money rail in the product. Money moves between test wallets, in play money, and cannot be converted to cash. Rapyd is not part of this flow.

## Linking a user's wallet (prompt 19, code written, tests not yet run)

- A user adds a wallet by its address. The app reads the wallet's public document (no key) and stores its address, asset code and scale.
- One active owner per wallet address. Adding a wallet that another user has linked is refused (`wallet_in_use`). A revoked wallet can be linked again.
- A new wallet is `pending`. It becomes `linked` only through consent (prompt 20). Revoking is done by the owner only; anyone else gets the same 404 as for a missing wallet.
- Only `https` addresses are accepted.

Status: **partly answered.** The sender side is confirmed. Two items are still open before the test transfer: a receiver wallet, and the testnet limits.

Sources checked on 2026-10-16:
- Before you begin: https://openpayments.dev/sdk/before-you-begin/
- Get keys bound to a wallet address: https://openpayments.dev/sdk/wallet-get-keys/
- Public wallet address document: https://ilp.interledger-test.dev/71dd8185 (answers HTTP 200 without credentials)

## 1. Test wallet provider and sign-up: answered

- **Sign-up site:** https://wallet.interledger-test.dev (Interledger Test Wallet, on the Interledger test network, with play money).
- **Caveat from the docs:** the environment runs on a GateHub pre-production system that mimics production.

## 2. Sender and receiver wallet addresses: partly answered

**Sender: answered.** The wallet address format is `https://ilp.interledger-test.dev/<id>`, and the sender wallet is `https://ilp.interledger-test.dev/71dd8185`. It is public and returns its details without credentials:
- asset code `EUR`, scale 2
- auth server `https://auth.interledger-test.dev/f537937b-...`
- resource server `https://ilp.interledger-test.dev/f537937b-...`

**Receiver: not answered.** Create a second wallet address in the test wallet and send its URL.

**Note:** the sign-up site and the wallet address host differ (`wallet.interledger-test.dev` and `ilp.interledger-test.dev`). The docs describe the first; the working wallet address uses the second. Both are on the same test network.

## 3. Registration steps: answered

1. Create an account at https://wallet.interledger-test.dev and confirm the email. The subject is "[Test.Wallet] Verify your account".
2. Complete KYC. Only a real email is needed; other fields can be made up.
3. Create a wallet account on the dashboard and choose an asset.
4. Deposit play money from the account page.
5. Add a wallet address with a wallet address name and a public name.
6. In Settings, open Developer Keys, expand the wallet account, and generate a key pair. A `private.key` file downloads, and the key ID appears on screen.

**Gap:** the docs do not explain how the key ID is formed. It is already available for the sender wallet.

## 4. Limits on testnet: not answered

The documentation states no limits (rate limits, transaction caps, account quotas, or expiry). Check this in the test wallet, or with the Interledger team, before the test transfer.

## 5. Credentials and where they live

| Value | `.env` variable | Location |
|---|---|---|
| Sender wallet URL | `OPEN_PAYMENTS_WALLET_ADDRESS` | `.env` (git-ignored) |
| Key ID | `OPEN_PAYMENTS_KEY_ID` | `.env` (git-ignored) |
| Ed25519 private key (PKCS8 PEM) | `OPEN_PAYMENTS_PRIVATE_KEY_PATH` | `C:\Users\guacalita-ceo-jlgb\guacapay-secrets\ilp-testnet-private.key`, **outside the repository** |

Checks done: the key file parses as an Ed25519 key (`asymmetricKeyType: ed25519`).

Naming: the values came under the names `ILP_TESTNET_*`. We use `OPEN_PAYMENTS_*` for consistency with the rest of the project. The key is stored as a file path, not inline in `.env`, so it does not sit in a text file that is easy to copy.

## 6. Open items

| # | Item | Blocks |
|---|---|---|
| 1 | Receiver wallet address URL | the test transfer (done-when check in prompt 08) |
| 2 | Testnet limits | confirming the test amounts |
| 3 | `RAPYD_WEBHOOK_URL` (public URL) | starting the gateway; not part of this step, but it stops `docker compose up` |
| 4 | Currency mismatch: the sender wallet is EUR, but our default accepted currency is USD | any test transfer. Payments must use the wallet's currency, or the currency list must change. |

## 7. Notes for the implementation

- The key file must be reachable inside the app container. The current compose mounts `keys/` from the repository. Before the transfer code runs, the mount should point at `C:\Users\guacalita-ceo-jlgb\guacapay-secrets`, and `OPEN_PAYMENTS_PRIVATE_KEY_PATH` should use the path inside the container.
- Do not send the key file or its contents anywhere. Send only the wallet URLs and the key ID.

## 8. Open design question

Who holds the money between a card payment (Rapyd) and the transfer to the recipient's testnet wallet? The reference analysis left this undecided (see `REFERENCE_ANALYSIS.md`, section 6). The sender wallet above is the platform's funding wallet, so this decision decides which wallet pays out.

## Recurring grants: interval format (not verified)

**Status:** not verified against the Open Payments specification. Checked on 2026-10-17:

- A web search for the grant `limits.interval` format returned no Open Payments page.
- `https://openpayments.dev/identity/grants/` has no `limits`, `debitAmount` or `interval` section.
- The specification source file on GitHub (`interledger/open-payments`, `openapi/auth-server.yaml`) returned 404 at the path tried.

**What the code assumes:** an ISO 8601 repeating interval, `R/<start>/<duration>`, where the duration is one of `P1D`, `P1W`, `P1M`. The start is the time the consent was given. `backend/src/grants/service.js` validates the pattern `^R\/[^/]+\/P[^/]+$`.

**To settle before live use:** read the `interval` description and example in the current Open Payments auth-server spec, then replace this section with the exact source and date.
