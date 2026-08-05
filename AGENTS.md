# Repository Guidelines

## Project Structure & Module Organization

The application is split by runtime boundary. `backend/` contains the Node server and
application logic: `server.js` serves static files and APIs, `alerts.js` owns alert state and
notifications, `auth.js` manages accounts/sessions, and `stream.js` handles optional WSS/SSE
updates. `frontend/` is a no-build vanilla-JS app: `index.html`, `js/` ES modules, and `css/`
stylesheets. Persistent local data is in `store/`; runtime error logs go in `logs/`.

Keep `config.json` local and untracked. Start from `config.example.json`; never add feed,
MongoDB, or Telegram credentials to code, commits, or documentation.

## Build, Test, and Development Commands

- `npm start` — start the local proxy and UI at `http://localhost:8787/`.
- `npm run live` — start with `STREAM_WS=1` to enable the optional live stream.
- `ALERTS_NO_TICK=1 npm start` — serve the app without evaluating or firing alerts; use this
  for UI checks and safe local investigation.
- `node -c backend/server.js` — syntax-check a backend file; repeat for every changed
  backend module.

There is no build step or automated test suite. The server performs a startup feed
reachability self-test. Verify affected APIs with authenticated, focused requests rather than
calling external feed endpoints directly.

## Coding Style & Naming Conventions

Use the existing JavaScript style: two-space indentation, semicolons, `const`/`let`, and
small focused functions. Use camelCase for variables/functions, PascalCase only for
constructor-like names, and uppercase constants such as `ALERT_POLL_MS`. Keep frontend code
inside the existing module boundaries and reuse CSS variables/components instead of adding a
parallel design system.

## Testing Guidelines

For backend changes, run `node -c` and start with `ALERTS_NO_TICK=1`; exercise only the
changed authenticated endpoint. For frontend changes, check module syntax and capture a
browser screenshot for visual changes. State what was verified and any feed-dependent checks
that could not be run outside market hours.

## Commit & Pull Request Guidelines

Recent commits use concise imperative subjects, e.g. `Sync alert actions across all surfaces`.
Keep one focused change per commit. PRs should explain behavior changes, identify affected
backend/frontend files, include verification output, link an issue when applicable, and attach
screenshots for UI changes. Do not commit `config.json`, store data, logs, or secrets.
