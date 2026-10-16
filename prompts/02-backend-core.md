# 02 — Backend core

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Create the minimal backend core in `backend/`.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and `docker/docker-compose.yml` before starting.

Steps:
1. Create `backend/package.json` with `"type": "module"`, scripts `start` and `dev`, and dependencies `express` and `dotenv`.
2. Create `backend/src/config.js`. This is the only file that reads `process.env`. It validates required variables at startup. If one is missing, it exits with a message that names the variable.
3. Create `backend/src/logger.js` with levels (debug, info, warn, error). It must never print values of variables whose names contain `KEY`, `SECRET`, `PASS`, or `TOKEN`.
4. Create `backend/src/errors.js` with an `AppError` class (code, status, message).
5. Create `backend/src/server.js`:
   - JSON body parser.
   - Static files from `frontend/`.
   - `GET /health` returns `{ "ok": true, "service": "app", "version": "<from package.json>" }`.
   - Every request gets an ID, returned in the `X-Request-Id` header.
   - One error middleware returns `{ "error": { "code", "message", "requestId" } }`. In production it never includes stack traces.
   - Unknown routes return the same JSON error shape, not HTML.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets into any file. Use placeholder values only in tests.
- Do not add database, auth, or payment code. Those are later prompts.

Done when:
- Starting without `JWT_SECRET` exits with an error that names `JWT_SECRET`.
- `GET /health` returns 200 with the JSON above.
- An unknown route returns the JSON error shape with status 404.
- A quick test script shows the logger does not print a value for a variable named `RAPYD_SECRET_KEY`.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
