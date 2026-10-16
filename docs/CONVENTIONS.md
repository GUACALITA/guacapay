# Conventions

These rules apply to all code, configuration, and documentation in this repository.

## Language

- Code, comments, documentation, commit messages, and prompt files are in English.

## File names

- Use kebab-case for every file and folder name: `payment-status.js`, not `PaymentStatus.js`.
- Exceptions are the standard names that tools require, such as `README.md`, `Dockerfile`, `package.json`, and `.env.example`.

## Code structure

- One responsibility per file.
- Environment variables are read only in `backend/src/config.js`. Every other module imports values from there.
- Each external provider has one adapter module. No other module calls the provider directly.
- The database is accessed only through `backend/src/db.js`.

## Secrets

- Real secrets, keys, and tokens never go into any tracked file.
- `.env` and `keys/` are git-ignored. `.env.example` lists variable names only, with no values.
- Logs never print values of variables whose names contain `KEY`, `SECRET`, `PASS`, or `TOKEN`.

## Node

- Node 20, pinned in `.nvmrc`.
- ES modules (`"type": "module"`).

## Working rules

- Changes are made in the working tree and reviewed before any commit.
- Each prompt in `prompts/` produces only the files it lists.
