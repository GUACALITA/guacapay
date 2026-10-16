# 16 — Documentation

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. Checks run: no reference to the other project and no secret values in any doc; every file named in the README and architecture doc exists; every required variable is in `.env.example`; the compose file validates. **Not verified:** the "under 30 minutes" test. It needs a fresh clone, real sandbox keys and a public webhook URL, and `docker compose up` cannot run on this machine while other containers hold ports 3202, 3203 and 8026. The stack's parts were each checked separately.
**Files produced:** `README.md` (rewritten), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (rewritten in order, decision 015 added, numbers unchanged), `AI_USAGE.md` (sections 3 and 4 filled in)

**Open items the docs state plainly:** the webhook encoding, the transfer, the currency choice, the key mount, and the rotation of the credentials from the earlier local `.env`.

## Prompt

Write the documentation so that someone who did not build the project can run it from the README alone.

Context: read every file in `docs/`, `prompts/`, and `AI_USAGE.md`, plus the current code, before writing.

Steps:
1. Update `README.md` with: what guacapay does, requirements (Docker, Node 20), setup steps, how to run with Docker Compose, how to run tests (`npm test`, `npm run test:sandbox`), and a link to each file in `docs/`.
2. Update `docs/ARCHITECTURE.md` with: the services and their ports, the data flow for one payment from start to `completed`, and a text diagram.
3. Update `docs/DECISIONS.md` with one entry per decision: SQLite, Rapyd only for collection, Open Payments on testnet for transfer, no own nodes, no Rafiki, JWT in `sessionStorage`, and the others recorded in earlier prompts.
4. Update `AI_USAGE.md`: fill in every row for the prompts that were executed, with the date, prompt file, files produced, and how the output was reviewed.
5. Do not describe anything as working unless a check in the matching prompt file passed. Mark anything unverified as "not yet verified".

Constraints:
- Build from zero. Do not copy text from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets, keys, or tokens into any file.
- Do not mention any other repository by name in any file in this repo.

Done when:
- A reader can follow the README from a fresh clone to a running sandbox in under 30 minutes (state how this was checked).
- Every decision in `docs/DECISIONS.md` has a reason.
- `AI_USAGE.md` has one row per executed prompt.

At the end, list every file created or changed with its full path, and any claim in the docs that is not yet verified.
