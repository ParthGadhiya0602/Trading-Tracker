# Repository Guidelines

## Project Structure & Module Organization

`backend/server.js` is the composition root. Configuration lives in `backend/config/`, shared
infrastructure in `backend/core/`, NSE session handling in `backend/net/`, and cash-market
ingestion in `backend/market/`. Business services live in `backend/services/`; derivatives
providers, polling, and WSS transport live in `backend/derivatives/`. HTTP concerns are split
between `backend/http/router.js`, response/SSE helpers, and focused handlers in
`backend/http/routes/`. Keep tests beside their domain modules as `*.test.js`.

`frontend/` is a no-build vanilla-JS app: `index.html`, view modules in `js/`, and shared or
view-specific styles in `css/`. Local persistence belongs in `backend/store/`, application
logs in `backend/logs/`, market captures in root `logs/`, and operational scripts in
`scripts/`.

Runtime configuration is environment-only. Keep `.env` local and untracked, document safe
placeholders in `.env.sample`, and never put feed, MongoDB, Telegram, LLM, or authentication
secrets in source or documentation.

## Build, Test, and Development Commands

- `npm start` — start the REST-backed app at `http://localhost:8787/`.
- `npm run live` — enable WSS plus market-status capture.
- `npm run closed` — serve UI/APIs with alert evaluation and Telegram polling disabled.
- `npm test` — run all `node:test` suites.
- `npm run doctor` — inspect Mongo connectivity and durable outboxes.
- `node --check backend/server.js` — syntax-check each changed JavaScript file.

There is no frontend build step. Use Node 24 LTS (24.11+); `.nvmrc` selects `lts/krypton`.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, `const`/`let`, camelCase functions/variables, and
UPPER_SNAKE_CASE constants. Keep functions small and domain logic in its existing module.
Reuse CSS tokens/components and existing ES-module boundaries; avoid parallel state stores or
design systems. Follow DRY and KISS without obscuring behavior behind premature abstractions.

## Testing Guidelines

Name tests `*.test.js` and colocate them with the owning backend domain. For backend edits, run
`npm test`, syntax checks, and a safe `npm run closed` smoke test. Exercise only affected
authenticated endpoints. For UI edits, check desktop and mobile breakpoints. Report any
feed-dependent checks that could not run outside the relevant market session.

## Commit & Pull Request Guidelines

Use concise imperative subjects and keep commits focused. PRs should explain behavior and
affected modules, include verification output, link relevant issues, and attach screenshots
when visual evidence is useful. Never commit `.env`, `backend/store/`, `backend/logs/`, root
`logs/`, or secrets.
