# Security review

Reviewed on 2026-10-16 against the rules in `REFERENCE_ANALYSIS.md`, plus a dependency audit and a container check. No secret values are written here; findings name only files and rules.

## Checks from prompt 15

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | No secrets in tracked files or history | **pass** | Real payment and wallet keys appear only in `.env`, which is git-ignored. No sensitive file is tracked. No Rapyd key appears anywhere in git history. |
| 2 | Every route validates input on the server | **pass** | Auth: email and 6-digit code. Payments: email, integer cents within limits, currency list, message length, idempotency key format. Claims: token length, email match, `https` wallet on an allowed host. Internal events: ID and type. Gateway: UUID, integer amount, currency code, `http(s)` return URL. |
| 3 | Webhooks verify the signature before reading the body; processing is idempotent | **pass**, with one open point | The gateway checks the signature on the raw body before parsing. Applied events are stored and not applied twice. A payment's status comes from a status request, not from the webhook. **Open:** no timestamp window, because Rapyd can resend old events (see finding F3). |
| 4 | OTP codes and claim tokens are stored only as hashes | **pass** | `hashSecret` (HMAC-SHA256) is used for `code_hash` and `token_hash`. Comparison uses `timingSafeEqual`. |
| 5 | Error responses do not leak stacks or provider internals | **pass** | Error bodies carry only a code, a fixed or safe message, and a request ID. Provider codes go to logs only. Tests check the body has no stack. |
| 6 | The Open Payments key is outside the repo and never logged | **not applicable yet**, with one open point | No code reads the key yet (prompt 08 is blocked). The key file is at `guacapay-secrets/`, outside the repo. **Open:** the compose file mounts `keys/` from inside the repo (see F6). |
| 7 | `.gitignore` covers `.env`, keys and databases; does not exclude `AI_USAGE.md` or `prompts/` | **pass** | Checked with `git check-ignore`: `.env`, `keys/`, `*.db` are ignored; `AI_USAGE.md`, `prompts/` and this file are not. |

## Other checks

| Check | Status |
|---|---|
| SQL injection | **pass**: all values are bound parameters. The only interpolated text is a fixed list of column names. |
| XSS in the frontend | **pass**: no `innerHTML`, `outerHTML` or `insertAdjacentHTML` in the frontend (tested). All text is set with `textContent`. |
| Dependencies (`npm audit --omit=dev`) | **fixed**: the backend had one high-severity advisory group in nodemailer (all versions up to 10.0.5). Upgraded to 10.1.2; audit now reports 0 vulnerabilities. Gateway: 0. |
| Non-root containers | **fixed**: both images now run as the `node` user (uid 1000). Verified: migrations write to the database volume as that user. |
| Browser protections on responses | **fixed**: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a Content Security Policy that allows only same-origin resources. Tests check them. |
| Build context | **fixed**: `.dockerignore` keeps `.env`, keys, databases, `node_modules`, docs and git history out of the image build. Verified that `.env` is not in the image. |
| Gateway port exposure | **pass**: bound to `127.0.0.1`, and checkout routes require `GATEWAY_TOKEN`. |
| Internal endpoint | **pass**: `/internal/payment-events` requires the gateway token, compared in constant time. |
| Account enumeration | **pass**: sign-in answers the same way for known and unknown addresses. Claim email checks happen only with a valid claim token. |
| Log content | **pass**: logs hold types, IDs and reference hashes. Codes, links, tokens, addresses and key values are not logged (tested). |

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | nodemailer had known vulnerabilities (SMTP injection, address parsing, TLS validation). | **Fixed**: upgraded to 10.1.2. Tests pass. The real SMTP path was checked earlier with Mailpit, before this upgrade. Repeat that check before production. |
| F2 | Medium | Containers ran as root. | **Fixed**: run as the `node` user. |
| F3 | Medium | No timestamp window on webhooks, so an old signed event could be replayed. The payment still cannot move without a status check, and a repeat is ignored. | **Open**: needs Rapyd's resend behavior, to be confirmed in the sandbox. |
| F4 | Medium | The session token is in `sessionStorage`, so any script running on the page could read it. | **Accepted, mitigated**: no `innerHTML`, a strict Content Security Policy, and no third-party scripts. |
| F5 | Low | Sign-out clears the token in the browser, but a copied token stays valid until it expires (1 hour). There is no server-side revocation. | **Open**: acceptable for now. Add a revocation list if sessions get longer. |
| F6 | Low | Compose mounts `keys/` from inside the repository, while the plan keeps the key outside. The folder is empty today. | **Open**: change the mount before the transfer code is added (prompt 08). |
| F7 | Low | The rate limit per IP is in memory and resets on restart. | **Accepted**: one instance. A shared store is needed before scaling out. |
| F8 | Info | `.env` holds credentials that came from another project, and they were pasted into this chat. | **Action for you**: rotate the Rapyd keys and the test wallet key, then replace them in `.env`. |

## Next steps

1. Rotate the credentials listed in F8, and use a sandbox key pair for guacapay.
2. Confirm Rapyd's webhook encoding and resend behavior with one real sandbox webhook (closes F3 and the signature question in `TESTING.md`).
3. Move the Open Payments key mount out of the repository before the transfer is built (F6).

## Review of the testnet-only flows (prompt 32, 2026-10-17)

Scope: the flows added in prompts 17 to 31 (wallets, consent, transfers, claims, requests, subscriptions, pools, splits, deposits and withdrawals, onboarding, dashboard, the end-to-end script). Reviewed by reading the code and the existing tests. The tests named below are written but **not run**, at the owner's request. Status meanings: **pass** (no open item), **pass, open item** (the check passes; an open finding is listed below), **open** (not fixed).

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Grants and tokens: stored encrypted, never logged, revoked on request, expired refused | **pass, open item** (F11) | Access and continuation tokens are sealed with AES-256-GCM (`grants/seal.js`). Logs carry types, IDs and reason codes only. The request log records the path, and no token travels in a path any more. Revoking clears both tokens (`grants/service.js`, `revokeGrant`; `grants.test.js`). An expired permission is refused with `grant_expired` (`getAccessToken`; `grants.test.js`). Open: revocation is local; the wallet's authorization server is not told (F11). |
| 2 | Consent callback: nonce checked, no replay | **pass, open item** (F12) | `finishConsent` checks the nonce hash, then requires the grant to be `pending`, so a second callback gets `grant_not_pending` (`grants.test.js`). Open: the nonce hashes are compared with `!==`, not in constant time (F12, low). |
| 3 | Wallet ownership: no user reads or acts on another user's wallet, grant, subscription, pool or request | **pass** | Every query filters by the signed-in user: wallets, grants (join on the wallet owner), payments (`sender_id`), balance, requests (`owner_user_id`), subscriptions (payee or payer), pools (organizer or member), splits (`payer_user_id`), deposits and withdrawals (`user_id`). Other users get the same 404 as for a missing row (`wallets.test.js`, `payments.test.js`, `requests.test.js`). Pools and subscriptions ownership is checked by code review only; tests are to be added later. |
| 4 | Money rules: no transfer without a linked wallet and consent; no payout above custody; no double charge per period; no double contribution per period | **pass, open item** (F13) | A transfer needs a linked wallet (`payFromWallet`, `createDeposit`, `createWithdrawal`, `createSplit`, `payRequest`) and a granted permission (the engine's `no_active_grant`). A payout above custody is refused by the database trigger and by `assertCustodyHolds`, before any money moves (`custody.test.js`). One charge per period: unique `(subscription, period)` (`subscriptions.test.js`). One contribution per period: unique `(pool, member, period)` (`pools.test.js`). Open: a withdrawal's balance debit runs after its transfer completes (F13). |
| 5 | Input validation on every new route, amounts in the wallet's asset scale | **pass** | Every new route checks its body: integer cents within limits, currency list, interval and period enums, note length, expiry range, idempotency-key pattern, token length, `https` wallet addresses. The engine refuses an asset that is not at scale 2 (`asset_mismatch`); `requestConsent` refuses other scales (`asset_scale_unsupported`). Path IDs are used only for lookups under the user's own filter. |
| 6 | Public pages show no wallet URL, email, token or internal ID | **pass** | Request links (`getPublicRequest`), subscription offers (`getPublicOffer`) and pool terms (`getPublicPool`) return amounts, status, expiry and a first name only; the request view is tested (`requests.test.js`). The wallet setup page has no form fields and takes its links from `frontend/config/setup.json` (`frontend-setup.test.js`). |
| 7 | Custody wallet keys and custody balance never exposed to users | **pass** | `/api/custody` requires the gateway token; a user's sign-in is refused (`custody.test.js`), and the response has no private material. No user route returns custody balances or the custody wallet URL. |
| 8 | Dependencies: `npm audit --omit=dev` on backend and gateway; new packages checked | **open** (F14) | Backend: 3 moderate advisories, all on `uuid` < 11.1.1 through `@interledger/open-payments`; no fix is published yet. The app never imports `uuid` (checked by search), so the vulnerable path is not reached. Gateway: 0. New packages: `qrcode` 1.5.4 (production) and `pngjs` 7.0.0 and `jsqr` 1.4.0 (development) report no advisories. |
| 9 | No secret in tracked files or history | **open** (F10) | No tracked file matches private-key or live-key patterns (search over the repo). The working copy and the current `.env.example` hold names only. **But** commit `7c496ae`, which had values in `.env.example`, is an ancestor of `origin/main`, so those values are in the shared history. See F10. |

### Summary of checks

| Status | Count |
|---|---|
| pass | 4 (checks 3, 5, 6, 7) |
| pass, open item | 3 (checks 1, 2, 4) |
| open | 2 (checks 8, 9) |

### New findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F9 | High | The server sent Open Payments requests to any `https` host a user named as a wallet address, and to any authorization or resource server a wallet document named. A user could make the server contact hosts they chose, and the error answers showed whether a host responded. | **Fixed**: every Open Payments call checks the host against `OPEN_PAYMENTS_HOSTS` (default: `ilp.interledger-test.dev` and `auth.interledger-test.dev`) before any request is sent (`providers/openpayments.js`, `assertAllowedHost`; `config.js`). Refusals are `wallet_host_not_allowed`. Regression tests: `backend/test/security-review.test.js` (written, **not run**). `allowHttp`, which lets tests use a local server, skips the check; production never sets it. |
| F10 | High | Commit `7c496ae` added example values to `.env.example`, and it is an ancestor of `origin/main`. The values are in shared history, and they include secret-looking names: `JWT_SECRET`, `HMAC_SECRET`, `GATEWAY_TOKEN`, `RAPYD_ACCESS_KEY`, `RAPYD_SECRET_KEY`, and the Open Payments key ID. The working copy and the current file hold names only. | **Open, needs the owner.** (1) Rotate every value that was in that commit: the Rapyd keys, the JWT, HMAC and gateway secrets, and the Open Payments key ID and key file. (2) Decide whether to rewrite the shared history (a forced push that removes the commit). That is destructive and shared, so it is not done here. |
| F11 | Medium | Revoking a permission only clears it locally; the wallet's authorization server is not told. | **Open**: add remote revocation once the Open Payments revoke call is confirmed. |
| F12 | Low | The consent nonce is compared with `!==`, not in constant time. | **Open**: compare with `timingSafeEqual` on the hash buffers. Low risk: the values compared are hashes of random nonces. |
| F13 | Medium | A withdrawal's balance debit and custody exit happen after the transfer completes, in one transaction. If that transaction failed, money would already have left custody. The reservation of in-progress withdrawals prevents the usual case. | **Open**: test the failure path against the real network (prompt 31's run); move the debit before the transfer if that test shows a gap. |
| F14 | Medium | `uuid` < 11.1.1 has moderate advisories through `@interledger/open-payments`, with no fix published. | **Open, accepted for now**: the app does not import `uuid`. Recheck with each `npm audit`. |
| F15 | Low | A permission whose wallet gives no expiry time never expires in the app. | **Open**: treat a missing expiry as a limit, or refuse it, once the wallets' behavior is confirmed. |

Findings F1 to F8 from prompt 15 are unchanged. F8 (credentials from another project, pasted in chat) still needs the owner's rotation.

### Next steps for the owner

1. Rotate the values listed in F10 and F8, then decide on the history rewrite for F10.
2. Run the test suite (`npm test` in `backend/`), including `security-review.test.js`. The fixes in this review are not verified until those tests pass.
3. Confirm the Open Payments revocation call (F11) and the expiry behavior (F15) with the test network.
