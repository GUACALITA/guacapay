# 10 — Frontend shell

**Date:** 2026-10-16
**Tool:** Claude Code (CLI), model Claude Haiku 5.5 (`claude-haiku-5-5`)
**Status:** executed 2026-10-16. Backend 67/67 automated tests pass (including the frontend checks). Headless Edge at 360 px wide: no horizontal overflow on index, new, payment and claim pages.
**Files produced:** `frontend/index.html`, `frontend/new.html`, `frontend/payment.html`, `frontend/claim.html`, `frontend/css/main.css`, `frontend/js/api.js`, `frontend/js/shell.js`, `backend/test/frontend-shell.test.js`; edited `backend/src/config.js` (`sandbox`), `backend/src/app.js` (`GET /api/config`), `docs/DECISIONS.md` (decision 011)

**Notes:**
- The app reads `RAPYD_SANDBOX` only to show the banner. The gateway uses it for real calls.
- The login, payment and claim forms are placeholders (disabled). Their logic belongs to prompts 11 and 12.

## Prompt

Create the basic frontend pages and layout, with no payment logic yet.

Context: read `REFERENCE_ANALYSIS.md`, `docs/CONVENTIONS.md`, and the current `backend/` code. The backend serves files from `frontend/`.

Steps:
1. Use plain HTML, CSS, and JavaScript modules. Do not add a framework.
2. Create these pages in `frontend/`:
   - `index.html`: home and the login form placeholder.
   - `new.html`: new payment form placeholder.
   - `payment.html`: payment status page, reads `?id=` from the URL.
   - `claim.html`: claim page placeholder, reads `?token=` from the URL.
3. Create `frontend/js/api.js`: one function for all backend calls. It adds the JWT from `sessionStorage` when present, parses JSON errors, and shows a single error message format.
4. Create `frontend/css/main.css` with a responsive layout that works at 360 px width with a 16 px side margin and no horizontal scroll.
5. Add a sandbox banner. The app exposes `GET /api/config` returning `{ "sandbox": true|false }` from `RAPYD_SANDBOX`. Create that route in the backend. The banner shows when `sandbox` is true.
6. Do not store the JWT in `localStorage`.

Constraints:
- Build from zero. Do not copy code, configuration, or file contents from any other repository.
- Everything in English.
- Do not create git commits, branches, stashes, or resets.
- Never write real secrets into any file.
- Do not add payment, claim, or WebSocket logic.

Done when:
- All four pages load from port 3202 with no console errors.
- The banner appears when `RAPYD_SANDBOX=true` and is hidden when false.
- At 360 px width, no page scrolls sideways (check in the browser).

At the end, list every file created or changed with its full path, and the output of each "Done when" check.
