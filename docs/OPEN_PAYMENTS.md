# Open Payments on the Interledger test network

Status: **blocked before code.** Four questions from prompt 08 must be answered before the transfer module is written. Two are answered by the official documentation. Two are not.

Sources checked on 2026-10-16:
- Before you begin: https://openpayments.dev/sdk/before-you-begin/
- Get keys bound to a wallet address: https://openpayments.dev/sdk/wallet-get-keys/

## 1. Test wallet provider and URL: answered

- **Provider:** Interledger Test Wallet, operated on the Interledger test network.
- **URL:** https://wallet.interledger-test.dev
- **Caveat from the docs:** the environment runs on a GateHub pre-production system that mimics production.

## 2. Sender and receiver wallet addresses: not answered

The documentation says you create wallet addresses yourself, by choosing a wallet address name and a public name. It does **not** give the URL format of a wallet address (for example `https://host/name`), and it does not say how to get one ready for use from code.

**Needed from you:** create two wallet addresses in the test wallet, then send me both URLs:
- a sender wallet (funds the transfer)
- a receiver wallet (test recipient)

## 3. Registration steps: answered, with one gap

1. Create an account at https://wallet.interledger-test.dev, then confirm the email sent from the test wallet. The subject is "[Test.Wallet] Verify your account".
2. Complete the KYC steps. The docs say only a real email is needed, and other fields can be made up.
3. On the dashboard, create a wallet account, name it, and choose an asset.
4. Open the account, click Deposit, and enter an amount. The account is funded with play money.
5. Add a wallet address: select the account, click "Add wallet address", and enter a wallet address name and a public name.
6. Open Settings, then the Developer Keys tab. Expand the wallet account and generate a key pair.
7. Enter a nickname. A file named `private.key` downloads automatically.
8. After closing the dialog, the key ID is shown on screen. A Show/Hide option reveals the public key.

**Gap:** the docs do not explain how the key ID is formed. We only know where to read it.

## 4. Limits on testnet: not answered

The documentation states no limits: no rate limits, no transaction caps, no account quotas, and no expiry for test accounts or keys. This must be checked in the test wallet itself, or with the Interledger team, before the test transfer.

## What we need to continue

| Item | Where it comes from | Where it goes |
|---|---|---|
| Sender wallet URL | Test wallet dashboard | `OPEN_PAYMENTS_WALLET_ADDRESS` in `.env` |
| Receiver wallet URL | Test wallet dashboard | Used only by the test script |
| Key ID | Developer Keys tab, after generation | `OPEN_PAYMENTS_KEY_ID` in `.env` |
| `private.key` file | Downloaded when the key is generated | A folder **outside** this repository. Its path goes in `OPEN_PAYMENTS_PRIVATE_KEY_PATH` |

Notes:
- The prompt says the private key lives outside the repository. The Docker stack currently mounts `keys/` from inside the repository. Before the key is used, we should change the mount to a folder you choose, so the key never sits in the repo.
- Keys and wallet data are private. Send only the URLs and the key ID here. Never send `private.key` or its contents.

## Open question for the design

Who holds the money between a card payment (Rapyd) and the transfer to the recipient's testnet wallet? The reference analysis left this undecided (see `REFERENCE_ANALYSIS.md`, section 6). The sender wallet above is the platform's funding wallet, so this decision affects which wallet we use.
