# 01 — Docker Compose stack

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** drafted, not executed
**Files produced:** _pending_

## Prompt

Create the Docker Compose stack for guacapay in `docker/`.

Context: read `REFERENCE_ANALYSIS.md` at the repo root for background only. Read `docs/CONVENTIONS.md` before starting.

Steps:
1. Create `docker/docker-compose.yml` with three services:
   - `app`: the backend, which also serves `frontend/`. Port 3202.
   - `gateway`: the payment gateway that wraps Rapyd (built later, see prompt 06). Port 3203. For now, use a placeholder Dockerfile that only starts an HTTP server with a `/health` route.
   - `mailcatcher`: a local email catcher. UI on port 8026.
2. Add a health check to each service that calls its `/health` route.
3. Mount a named volume for the SQLite database file. Mount `keys/` read-only into `app`.
4. Load environment from `.env` with `env_file`. Do not hard-code any value.
5. Do not add Postgres or Redis.
6. Create one Dockerfile per Node service: `docker/app.Dockerfile` and `docker/gateway.Dockerfile`. Use Node 20 Alpine.

Constraints:
- Build from zero. Do not copy any file from another repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets into any file.
- The placeholder `/health` routes are the only application code in this prompt.

Done when:
- `docker compose -f docker/docker-compose.yml config` validates with no errors.
- `docker compose -f docker/docker-compose.yml up --build` starts all services, and each health check reports healthy.
- `http://localhost:3202/health` and `http://localhost:3203/health` return 200.
- `http://localhost:8026` shows the mail catcher UI.

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
