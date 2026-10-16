# AI Usage

This document records which AI tools were used in this project, for which tasks, in which parts of the codebase, and with what configuration.

**Written for:** the project team.

---

## 1. Tools

| Tool | Version / model | Used for | Scope in the project |
|---|---|---|---|
| Claude Code (CLI) | Claude Haiku 5.5 (`claude-haiku-5-5`) | _to fill_ | _to fill_ |

## 2. Usage log

Each entry links to the prompt file in `prompts/` that produced the work.

| Date | Prompt file | Tool | Area (backend / frontend / docker / js / websocket / docs) | Files touched | Notes |
|---|---|---|---|---|---|
| 2026-10-16 | `prompts/00-project-setup.md` | Claude Code, Claude Haiku 5.5 | docs / setup | `README.md`, `.gitignore`, `.env.example`, `.nvmrc`, `docs/CONVENTIONS.md`, folders | Ran the prompt. Verified ignore rules with `git check-ignore` (read-only). Removed default values from `.env.example` to match the prompt's "no values" rule. |
| 2026-10-16 | `prompts/01-docker-compose.md` | Claude Code, Claude Haiku 5.5 | docker | `docker/docker-compose.yml`, `docker/app.Dockerfile`, `docker/gateway.Dockerfile`, placeholder `backend/` and `gateway/` servers | `docker compose config` passes; both images build; `/health` returns 200 for app and gateway in temporary containers. Full `up` not run: mailpay containers hold ports 3202, 3203, 8026. Placeholder servers are replaced in prompts 02 and 06. |

## 3. Components and configuration

_To fill: any AI-specific configuration used (rules files, skills, plugins, settings), with the reason for each._

## 4. Human review

_To fill: how each AI-generated change was reviewed before it was accepted._
