# 35 — Platform key created on this machine, public part uploaded

**Date:** 2026-10-17
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** script written and run. The wallet upload and the key ID are **pending** the owner. Tests not run, at the owner's request.
**Files produced:** `backend/scripts/make-platform-key.js`; `keys/platform-key-candidate.pem` (private, git-ignored, not in any document)

## Prompt

The platform's Open Payments wallet (`https://ilp.interledger-test.dev/71dd8185`) needs a key pair that the app uses to sign its requests. The private part must never be pasted into a chat, a document or a wallet form. The public part is uploaded to the wallet.

Steps:
1. A script creates an Ed25519 key pair on the owner's machine. The private key is written to `keys/` with restricted permissions. The script never prints it and never overwrites an existing file.
2. The script prints only the public key (PEM).
3. The owner uploads the public key in the platform wallet's Developer Keys ("Upload key"), and the wallet returns a key ID.
4. The owner sends the key ID (public) so the configuration can point to it.

Constraints:
- No private key appears in a chat, a document, a commit or the terminal output.
- The script does not call the wallet's dashboard or its account API. No login is automated.
- Everything in English. No commits.

Done when:
- The script runs and writes the candidate key file without printing it.
- The public key is uploaded to the platform wallet and the key ID is recorded.
- The app signs with the new key and a test consent succeeds (manual check, pending).

## Result so far

- The script was run in a Node container. It wrote `keys/platform-key-candidate.pem` and printed one public key.
- The public key was not uploaded yet; the key ID is not known yet.
- The key in use today is `keys/ilp-testnet-private.key` (Ed25519, the same key as the one registered for the platform wallet). It was not replaced.

## Exposed keys (owner actions)

Private keys were pasted into chats during this work. Each must be revoked in its wallet's Developer Keys, and the copies in `keys/` deleted once revoked:

- Wallet `3232323` (COP): key ID `470b281f…`, and the copy `keys/private.key`.
- A key registered on account `0a9c2de6…` with nickname `aaaaa`, key ID `c3ec78a3…`.

## Files changed

- `backend/scripts/make-platform-key.js` (new)
- `prompts/35-platform-key-local.md` (new)
- `keys/platform-key-candidate.pem` (new, private, git-ignored)
