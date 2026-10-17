# End-to-end run on the Interledger test network

**Status:** **not yet run.** The run needs two things only the owner can do:

1. The sender wallet linked in the app, with its consent approved in the wallet (the script never approves).
2. Play money in the sender wallet (manual deposit on the test network).

This file is replaced with the output of one successful run, with its date. It must contain no secrets and no tokens.

## How to run

From `backend/`, with the repo-root `.env` filled in:

```
TESTNET_SENDER_WALLET=https://ilp.interledger-test.dev/<sender-id>
TESTNET_RECIPIENT_WALLET=https://ilp.interledger-test.dev/<recipient-id>
TESTNET_RECIPIENT_EMAIL=<any email; no email is sent to it by the script>
TESTNET_AMOUNT_CENTS=10
PAYMENT_CURRENCIES=EUR
CUSTODY_WALLET_ID=<id of the custody wallet row>
CUSTODY_WALLET_ADDRESS=<custody wallet address>
```

```
npm run e2e:testnet
```

Exit codes: `0` completed, `1` failed at a step (the step name and reason are printed), `2` stopped before any money moved (for example, consent not approved yet; the approval link is printed).

## What the run proves, and what it does not

- It proves both transfers on the real test network: sender wallet to custody, then custody to the recipient wallet, each read until the network reports it completed.
- The recipient's login code is taken from the script's own mailer, not from the recipient's inbox. Email delivery is not part of this proof.
- It runs the same functions the app uses: `payFromWallet` and `confirmClaim`.

## Output of the successful run

_Pending._
