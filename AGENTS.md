# Repository Guidelines

## Project Structure & Module Organization

The app is split by runtime boundary. `backend/server.js` owns HTTP, authenticated APIs,
market-session routing, SSE, and static serving. Domain modules include `alerts.js`,
`auth.js`, `trades.js`, `telegram.js`, `llm.js`, `stream.js`, and the central in-memory
`market-store.js`; shared persistence helpers live in `durable-outbox.js`, `mongo-retry.js`,
and `logger.js`. `frontend/` is a no-build vanilla-JS app: `index.html`, page modules in
`js/`, and shared/page styles in `css/`. Node tests use `backend/*.test.js`. Local state and
logs belong in gitignored `store/` and `logs/`; operational helpers belong in `scripts/`.

Runtime configuration is environment-only. Keep `.env` local and untracked, document safe
placeholders in `.env.sample`, and never put feed, MongoDB, Telegram, LLM, or authentication
secrets in source or documentation.

## Build, Test, and Development Commands

- `npm start` — start the REST-backed app at `http://localhost:8787/`.
- `npm run live` — enable WSS plus market-status capture.
- `npm run closed` — serve UI/APIs with alert evaluation and Telegram polling disabled.
- `npm test` — run all `node:test` suites.
- `npm run doctor` — inspect Mongo connectivity and durable outboxes.
- `node -c backend/server.js` — syntax-check each changed backend file.

There is no frontend build step. Use Node 24 LTS (24.11+); `.nvmrc` selects `lts/krypton`.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, `const`/`let`, camelCase functions/variables, and
UPPER_SNAKE_CASE constants. Keep functions small and domain logic in its existing module.
Reuse CSS tokens/components and existing ES-module boundaries; avoid parallel state stores or
design systems. Follow DRY and KISS without obscuring behavior behind premature abstractions.

## Testing Guidelines

Name tests `backend/<module>.test.js`. For backend edits, run `npm test`, syntax checks, and a
safe `npm run closed` smoke test. Exercise only affected authenticated endpoints. For UI edits,
check desktop and mobile breakpoints and capture a browser screenshot. Report feed-dependent
checks that could not run outside the relevant market session.

## Architecture References

Use `README.md` for current operation, `ALERT_ARCHITECTURE.md` for locked alert/RBAC rules,
and `MARKET_DATA_CONTRACT.md` for session payloads. Planning/review files describe historical
decisions and are not substitutes for current implementation.

## Commit & Pull Request Guidelines

Use concise imperative subjects and keep commits focused. PRs should explain behavior and
affected modules, include verification output, link relevant issues, and attach screenshots
for UI changes. Never commit `.env`, `store/`, `logs/`, or secrets.
