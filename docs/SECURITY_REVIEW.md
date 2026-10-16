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
