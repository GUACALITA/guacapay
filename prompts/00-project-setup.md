# 00 — Project setup

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Set up the empty repository skeleton for guacapay in `C:\Users\guacalita-ceo-jlgb\Documents\GitHub\guacapay`.

Context: read `REFERENCE_ANALYSIS.md` at the repo root for background only.

Steps:
1. Create the folders `backend/`, `frontend/`, `docker/`, `docs/`. The `prompts/` folder already exists.
2. Create a root `README.md` that replaces the current stub. It points to `docs/` and `prompts/` and says the project is in setup.
3. Create a root `.gitignore` that excludes: `.env`, `node_modules/`, `*.db`, `*.db-wal`, `*.db-shm`, `keys/`, `*.key`, `logs/`, `.DS_Store`. Do not exclude `AI_USAGE.md` or `prompts/`.
4. Create `.env.example` with variable names and comments only, no values. Use these names: `APP_PORT` (3202), `GATEWAY_PORT` (3203), `BASE_URL`, `JWT_SECRET`, `HMAC_SECRET`, `RAPYD_ACCESS_KEY`, `RAPYD_SECRET_KEY`, `RAPYD_SANDBOX`, `OPEN_PAYMENTS_WALLET_ADDRESS`, `OPEN_PAYMENTS_KEY_ID`, `OPEN_PAYMENTS_PRIVATE_KEY_PATH`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.
5. Create `.nvmrc` containing `20`.
6. Create `docs/CONVENTIONS.md` with these rules: file names in kebab-case; code and comments in English; one responsibility per file; environment variables are read only in `backend/src/config.js`.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets. Leave changes in the working tree.
- Never write real secrets, keys, or tokens into any file.
- Do not write application code. This prompt is folders and config files only.

Done when:
- All folders in step 1 exist.
- `.gitignore` covers the items in step 3.
- `.env.example` has no real values.
- `docs/CONVENTIONS.md` exists.

At the end, list every file created or changed with its full path.
