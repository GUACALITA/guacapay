# Reference Analysis (read-only)

**Purpose:** Architecture analysis of a reference codebase, used only to guide a clean rebuild in this repository.
**Rule:** No code, configuration, secrets, or file contents are copied from the reference. Everything here is rebuilt from zero.
**Written for:** the project team (internal planning).

---

## 1. Summary of the reference

A payment application that lets a user send money to an email address. The recipient receives a claim link, verifies with a one-time code, and chooses a payout destination. Payments are signed with a post-quantum signature (ML-DSA-65 / Dilithium3) on top of an Open Payments flow.

## 2. Stack observed

| Layer | Technology |
|---|---|
| Main server | Node.js 20, Express 4, ES modules |
| Storage | SQLite via `better-sqlite3` |
| Email | Nodemailer; a local mail catcher in development |
| Auth tokens | `jsonwebtoken` (JWT) |
| Open Payments | `@interledger/open-payments` 7.x |
| Post-quantum | `@noble/post-quantum` (ML-DSA-65) |
| QR codes | `qrcode` |
| Containers | Docker Compose, Node 20 Alpine base image |

## 3. Components

| Component | Role | Port |
|---|---|---|
| main app | One-time code login, payments, claims, wallet addresses | 3202 |
| payment gateway (hub) | Rapyd checkouts, payouts, webhooks | 3203 |
| mail catcher | Local email UI for development | 8026 (UI) |

**Important:** in the reference, port 8026 is the local mail catcher UI, not the payment gateway. See section 8.

## 4. Payment flow (conceptual)

1. Sender authenticates with a one-time code sent to their email.
2. Sender enters recipient email, amount, and message.
3. The app creates a payment record and a post-quantum signature over its key fields.
4. Card money is collected through Rapyd.
5. A claim link is emailed to the recipient.
6. Recipient opens the link, verifies a one-time code, and picks a destination.
7. The app executes the Open Payments transfer on a test wallet: incoming payment at the recipient's wallet, quote, outgoing payment.
8. Confirmation email goes to the sender.

## 5. Security model (concepts only)

- One-time codes for login and claim verification.
- Secrets come from environment variables. The reference keeps a local `.env` (git-ignored) and an example file with variable names only.
- Post-quantum signature layer for claim links, so a claim link cannot be forged even if the HMAC secret leaks.
- Open Payments requires Ed25519 keys for request signing.
- The reference repository contains a private key file. It must never be committed, and it is not reproduced here.

## 6. Rapyd status observed in the reference (from its own report, 2026-10-16)

- Creating a checkout in the Rapyd sandbox works (verified through the gateway).
- Checkout status query works and returns `NEW` / `paid: false` until paid.
- A real sandbox payment has **not** been verified end to end yet.
- Intermittent network failure to Rapyd was seen once and could not be reproduced.
- The reference has a fallback to a second payout provider when Rapyd fails. That fallback sits on the payout path, not the collection path. Design decision needed for guacapay: keep it or not.
- Open question from the reference: whether card money stays in the internal ledger until claim, or moves to the destination wallet immediately.

These are lessons to design around, not code to reuse.

## 7. Lessons for the rebuild

1. Keep the Rapyd integration behind one adapter module, so the rest of the app does not depend on it.
2. Decide the custody model up front: when does money leave the internal ledger?
3. Do not put a payout fallback on the collection path.
4. Webhooks and polling must be idempotent. Mark a payment as paid only once.
5. Never commit `.env`, keys, or database files. Add `.gitignore` entries before the first file that needs them.
6. Keep Open Payments behind one adapter module, so the test wallet can be swapped without touching payment logic.
7. Start with a health endpoint on the app.
8. Keep AI-generated work recorded in `AI_USAGE.md`.

## 8. Discrepancies and risks to resolve

| # | Item | Action |
|---|---|---|
| 1 | Port 8026 is a mail catcher in the reference, not a payment gateway. | Confirm in guacapay which port the gateway uses. |
| 2 | Reference has a private key file in the repo root. | Guacapay: keys in environment or secret store only, never in the repo. |
| 3 | Payout fallback on the collection path. | Decide before implementing the payment module. |
| 4 | Sandbox payment never verified in the reference. | Plan an explicit sandbox test in guacapay. |
| 5 | Open Payments test wallet URL and registration requirements not yet confirmed. | Verify in Interledger documentation before implementing. |

## 9. Scope for guacapay (as stated by the team)

- Backend, frontend, Docker, JavaScript, WebSocket.
- Rapyd as the only external card payment provider (reference: https://docs.rapyd.net/es/index-es.html).
- Open Payments on Interledger testnet for the transfer leg. No own nodes, no Rafiki, no ILP connector.
- No Guacalita node, no Chimoney integration for now.
- Local endpoints for first development:
  - Email catcher UI: http://localhost:8026/
  - Claim / app: http://localhost:3202/
  - New payment page: http://localhost:3202/new.html
- All documentation in English.
- Prompts used to generate work are stored in `prompts/` and listed in `AI_USAGE.md`.
