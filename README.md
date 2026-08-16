# Trading Tracker

A no-build Node.js and vanilla-JavaScript personal markets app for the Indian market (NSE), with seven role-aware views:

- **Dashboard** — a personal overview: live index cards + your P&L, active alerts, notifications, and recent trades (each panel shows the first 3 with _See all / Show less_).
- **Market Watch** — live constituents per index (NIFTY 50 / NEXT 50 / MIDCAP 50 / MIDCAP 100) with the Open=High (red) / Open=Low (green) row model, filters, search, sortable columns, a Top Gainers / Losers / Most Active rail, and a click-a-row **stock detail modal**(details + pre-open order book + Alerts + AI Analysis tabs).
- **Futures & Options** — read-only index and stock option chains, index and stock futures, observed facts, REST reconciliation, and optional live option-chain updates.
- **Alerts** — server-evaluated price alerts (fire even with no tab open), with an approve/reject review gate and Telegram delivery.
- **Trades** — a manual trade journal (intraday vs swing kept separate; log an entry, close it later, P&L derived).
- **Reports** — analytics on your trades (equity curve, per-period P&L, win rate, profit factor, R-multiples, best/worst, by-strategy) — hand-drawn inline SVG, no chart library.
- **Users** — admin-only account, role, access, and Telegram connection management.

Responsive: a left sidebar rail on laptop/desktop; a hamburger menu + bottom-sheet modals on mobile. Light/dark follow the system theme.

![Node 24 LTS](https://img.shields.io/badge/node-24%20LTS-brightgreen)---

## Requirements

- **Node.js 24 LTS (24.11+)**. With nvm, run `nvm use`; otherwise check with `node --version` and install a supported 24.x LTS release.
- **Environment variables** for all config (see `.env.sample`): `AUTH_PASSWORD_PEPPER`, `MARKET_BASE_URL`, and `MARKET_INDICES_ENDPOINT` are required; MongoDB, streaming, derivatives, Telegram, and LLM settings are optional.
- A network the data source answers on — home/office broadband is fine; VPN/datacentre IPs are often blocked (HTTP 401/403).
- `npm install` installs the MongoDB driver declared by the backend. The frontend still has no package build or framework runtime.

---

## Setup

1. Copy the sample and fill it in:

   ```bash
   cp .env.sample .env
   ```

2. Generate the required auth pepper (server refuses to start without it, min 32 chars) and put it in `.env` → `AUTH_PASSWORD_PEPPER`:

   ```bash
   openssl rand -hex 32
   ```

   Back it up; don't rotate it without resetting every user's password.

3. Fill the grouped `MARKET_*` variables in `.env`. The configuration adapter rebuilds the internal feed object; JSON escaping is not required. Stream origins reuse `MARKET_BASE_URL`, and both WSS transports reuse `MARKET_STREAM_BASE_URL`.
4. (Optional) Set `MONGO_URI` (Atlas), `TELEGRAM_BOT_TOKEN`, `LLM_*`.
5. Start the app (see **Running**) and open it; the first run shows a **Create admin** screen.

### Environment variables

**Secrets / config (all via env):**

| Variable                                                                            | Purpose                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `AUTH_PASSWORD_PEPPER`                                                              | **Required** (&gt;= 32 chars, `openssl rand -hex 32`). Replaces `auth.passwordPepper`.  |
| `MONGO_URI`                                                                         | MongoDB Atlas connection string (omit for local file storage).                          |
| `MARKET_BASE_URL` / `MARKET_INDICES_ENDPOINT`                                       | Required market origin and index REST endpoint.                                         |
| `MARKET_*`                                                                          | Optional REST, index-stream, derivatives, and commodity paths grouped in `.env.sample`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME`                                      | Telegram bot (optional). Replace `telegram.*`.                                          |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | LLM analysis (dormant without a key). `LLM_ENABLED=false` forces off.                   |

**Runtime toggles:**

| Variable                              | Purpose                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                | HTTP port (default `8787`).                                                                                             |
| `HOST`                                | Bind address (default `127.0.0.1`). Set `0.0.0.0` to accept external connections directly (e.g. an EC2 security group). |
| `STREAM_WS=1`                         | Enable configured index and derivative WebSocket feeds; serves index SSE at `/api/stream`. Off = REST polling.          |
| `DERIVATIVES_ENABLED=1`               | Enable authenticated Futures & Options APIs and workspace.                                                              |
| `DERIVATIVES_FUTURES_ENABLED=1`       | Enable index and stock futures polling.                                                                                 |
| `DERIVATIVES_STOCK_OPTIONS_ENABLED=1` | Enable the stock-symbol master and equity option chains.                                                                |
| `DERIVATIVES_COMMODITY_ENABLED=1`     | Enable commodity futures and option chains.                                                                             |
| `DERIVATIVES_ALLOW_CLOSED_REVIEW=1`   | Allow one on-demand derivatives snapshot outside market hours.                                                          |
| `DERIVATIVES_POLL_SECONDS`            | REST reconciliation cadence while a derivatives view has demand (minimum `3`, default `5`).                             |
| `STORE_REFRESH_SECONDS`               | Market-hours background refresh cadence for the store (default `3`).                                                    |
| `ALERTS_NO_TICK=1`                    | Serve UI + APIs but **don't** evaluate alerts (no fires / no Telegram). Also disables Telegram polling.                 |
| `TELEGRAM_DISABLED=1`                 | Disable Telegram polling on this instance (run secondary instances with this so only one polls the bot).                |
| `MARKET_CAPTURE=1`                    | Log every `marketStatus` transition + a raw sample to `logs/market-capture-<date>.jsonl`.                               |
| `STREAM_CAPTURE=1`                    | Log a bounded sample of raw WSS frames for stream-schema diagnosis.                                                     |

**Deploy with no config file:** set `AUTH_PASSWORD_PEPPER` and the required `MARKET_*`variables (+ MongoDB / Telegram / LLM as needed), then either load a `.env` natively —

```bash
node --env-file=.env run.js      # Node 24 LTS (24.11+)
```

— or export the vars in your process manager (pm2 env / systemd `Environment=`).

---

## Running

Cross-platform (macOS / Windows / Linux) via npm scripts or the `run.js` launcher — no shell-specific env syntax needed:

```bash
npm start              # normal run                → http://localhost:8787/
npm run live           # live WS feed + market capture
npm run stream         # live WS feed only
npm run capture        # market-status capture only
npm run closed         # no alert evaluation (ALERTS_NO_TICK)
npm run doctor         # MongoDB and durable-outbox diagnostics
```

Or call the launcher directly with flags (identical on every OS):

```bash
node run.js --stream --capture --port=9000
node run.js --no-tick          # ALERTS_NO_TICK
node run.js --no-telegram      # TELEGRAM_DISABLED
```

On Windows you can also double-click / run `run.cmd` (passes flags through). macOS/Linux users can use `run.sh`.

To enable the LLM later, set its env vars, e.g.:

```bash
LLM_PROVIDER=gemini LLM_API_KEY=<key> LLM_MODEL=gemini-2.5-flash node run.js
# Windows PowerShell:
#   $env:LLM_PROVIDER="gemini"; $env:LLM_API_KEY="<key>"; node run.js
```

Startup connects to storage in parallel and runs the data-source self-test in the background, so the server is reachable in \~2s. Stop with **Ctrl-C**.

---

## Market hours & data

Live data flows **Mon–Fri, IST**: pre-open **09:00–09:15**, continuous session **09:15–15:30**; otherwise **closed** (weekends included). Off-hours the index cards show the **last close** and the constituents table is empty until the market opens — this is expected.

- The **order book / depth** is available **only during pre-open** (in the stock detail modal). The continuous-session feed and the WS stream carry no per-stock depth.
- `/api/indices` returns each index's level + all constituents (OHLC, LTP, prev close, change, volume, turnover, 52-week, advance/decline, market status).
- A central in-memory market store backs APIs, alert evaluation, derived lists, and SSE. REST refreshes it in the background; live WSS ticks patch that same snapshot.

### Futures & Options data

The derivatives workspace is demand-driven: opening a chain or futures view starts backend collection, normalized snapshots are stored under `store.derivatives`, and SSE delivers them to the browser. Option chains use REST as the baseline and reconciliation source. When both `STREAM_WS=1` and `MARKET_DERIVATIVE_STREAM_PATH` are configured, option-chain WSS ticks patch the same snapshot. Index and stock futures use the configured derivatives REST endpoint.

Stock-option symbols come from `MARKET_DERIVATIVE_MASTER_QUOTE_ENDPOINT`; expiries come from the contract-info endpoint. Feature flags can expose index options, futures, stock options, and commodities independently.

### Previous `FEED_JSON` mapping

| Previous property                                                            | New source                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `base`                                                                       | `MARKET_BASE_URL`                                                      |
| `indicesEndpoint`, `preopenEndpoint`, `referer`                              | `MARKET_INDICES_ENDPOINT`, `MARKET_PREOPEN_ENDPOINT`, `MARKET_REFERER` |
| `warmupPaths`                                                                | Code constant in `backend/config/nse.config.js`                        |
| `stream.wsBase`                                                              | `MARKET_STREAM_BASE_URL` + `MARKET_INDEX_STREAM_PATH`                  |
| `stream.origin`                                                              | Reuses `MARKET_BASE_URL`                                               |
| `stream.indexParam`                                                          | Code constant `index`                                                  |
| `stream.constituents.*.path`                                                 | Four `MARKET_*_CONSTITUENTS_PATH` variables                            |
| `stream.levels.*.path`                                                       | Four `MARKET_*_LEVEL_PATH` variables                                   |
| Constituent/level object keys and `index` values                             | Code constants                                                         |
| `derivatives.masterQuoteEndpoint`, `stockQuoteEndpoint`                      | Corresponding `MARKET_DERIVATIVE_*` endpoint variables                 |
| `derivatives.contractInfoEndpoint`, `optionChainEndpoint`, `futuresEndpoint` | Corresponding `MARKET_DERIVATIVE_*` endpoint variables                 |
| `derivatives.referer`, `futuresReferer`                                      | `MARKET_DERIVATIVE_REFERER`, `MARKET_DERIVATIVE_FUTURES_REFERER`       |
| `derivatives.enabledSymbols`                                                 | CSV `MARKET_DERIVATIVE_SYMBOLS`, converted to a deduplicated array     |
| `derivatives.commodity*`                                                     | Corresponding `MARKET_COMMODITY_*` variables                           |
| `derivatives.stream.wsBase`                                                  | `MARKET_STREAM_BASE_URL` + `MARKET_DERIVATIVE_STREAM_PATH`             |
| `derivatives.stream.origin`                                                  | Reuses `MARKET_BASE_URL`                                               |
| `derivatives.stream.path`, `symbolParam`, `expiryParam`                      | Code constants `mbp`, `symbol`, `expiry`                               |

---

## Storage (local file or MongoDB Atlas)

By default everything persists to local files in `backend/store/` (no setup). To share data **across devices**, set `MONGO_URI` and run `npm install`. It always also writes the local cache files and replays offline changes idempotently when Atlas returns, so the app never blanks. Startup logs show `store: mongo` or `store: file`.

**Connecting from another device / network:**

- `querySrv ECONNREFUSED …mongodb.net` = the network's DNS can't resolve the `mongodb+srv://` SRV record. Fix by switching that device's DNS to `1.1.1.1` / `8.8.8.8`, **or** use Atlas's **standard (non-SRV) connection string** (`mongodb://host1,host2,host3/…`) as `MONGO_URI`.
- If you get a _connection timeout_ instead, either the **IP isn't allow-listed** in Atlas (Network Access → add your IP or `0.0.0.0/0`) or outbound **port 27017** is blocked on that network.

---

## Alerts (summary)

Set price alerts per index (or from a stock's detail modal). Alerts are evaluated **on the server** during market hours, so they fire with no tab open.

- Fields: index, stock, side (Buy/Sell), **entry price**, stop loss, note, **time frame**(1s…12mo). The **trigger** sits offset% away from entry (offset scales with the time frame); re-alerts step back toward entry.
- Lifecycle **armed → triggered → active → closed**. **Entry** (touching the entry price) is the gate — profit targets (3×/5×) and stop-loss are tracked only after entry. Success/Fail auto-close.
- **Review gate:** every alert starts _pending_. Only an editor/admin-approved alert is evaluated or fires; pending and rejected alerts remain dormant.
- Fires reach the in-page **notification center** (bell) and, if configured, **Telegram**. Filter the list by index / status / side / time frame / review / outcome; closed alerts move to an archive.

### Telegram (optional)

Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME` (from **@BotFather**) in the env. Each user opens **Telegram settings → Create connection link** and connects the bot; link codes are single-use and expire in 10 minutes. Without this, alerts are **in-page only**. Run only **one** instance with Telegram enabled (others with `TELEGRAM_DISABLED=1`) — Telegram allows one poller per bot.

---

## Trades & Reports (summary)

- **Trades** — log each trade manually: type (intraday/swing), symbol, side, qty, entry price/date/time, and later exit + charges to close it. P&L (gross/net/%, R-multiple, holding period) is derived. Filter by type/status/side/date; edit/delete is creator-scoped.
- **Reports** — analytics computed from your closed trades: equity curve, per-period P&L (daily/weekly/monthly), win rate, profit factor, expectancy, max drawdown, avg R, best/worst trades, and a by-strategy breakdown. Segment by intraday/swing.

---

## Roles & security

Roles: **admin** (users + alerts + trades), **editor** (alerts + trades), **viewer**(read-only). Passwords use scrypt + a per-user salt + the environment pepper; sessions are in-memory HttpOnly cookies (12h idle). Every `/api/*` needs a session; writes need editor/admin; non-GET requires an `X-Requested-With` header (CSRF).

---

## Logging

Errors/warnings/info are written to a **daily-rotating** file `backend/logs/<YYYY-MM-DD>.log` (IST), pruned after 14 days. Market-status captures remain in root `logs/market-capture-<date>.jsonl`. Persistence, connection, and Telegram failures are also echoed to the console.

---

## Project layout

```
backend/
  server.js              composition root and process lifecycle
  config/                environment parsing and market configuration assembly
  core/                  market store, outbox, Mongo retry, logging, utilities
  derivatives/           option/futures providers, demand service, option WSS
  http/                  router, response/SSE helpers, domain route handlers
  market/                cash feed, WSS, capture, market state, live orchestration
  net/                   shared warmed NSE session and traffic coordination
  services/              alerts, auth, trades, Telegram, LLM, alert policy
  store/                 local JSON persistence and durable outboxes
  logs/                  rotating application logs
frontend/
  index.html             application shell and view markup
  css/                   shared tokens/components and view-specific styles
  js/                    vanilla-JS view and state modules
scripts/
  mongo-doctor.mjs       Mongo connectivity and outbox diagnostics
root                     package.json, run launchers, .env.sample, capture logs
```

Backend tests are colocated with their modules as `*.test.js`; run all of them with `npm test`.
