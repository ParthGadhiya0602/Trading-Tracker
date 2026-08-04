# Trading Tracker - NIFTY 50 / NIFTY NEXT 50 Dashboard

Tracks each constituent's intraday movement **relative to its open**, plus each
index's own live points level. Data is a live market feed (unofficial), market hours only
(Mon–Fri 09:15–15:30 IST).

## Architecture

Split into **`backend/`** (Node server) and **`frontend/`** (the static app it serves).
A pure-browser page can't reach the upstream feed (CORS forbids the needed headers; its
anti-bot layer blocks any request without a warmed session), hence the local proxy.

`config.json`, `logs/`, and `package.json`/lockfile live at the **repo root**; alert + user
data (`alerts.json`, `users.json`) live in **`store/`**; `backend/*.js` reaches them via `..`.

- **`backend/server.js`** - Node 18+, **zero dependencies** (built-in `fetch` + hand-rolled
  cookie jar). Warms an upstream session (cookies + browser headers, rewarm-on-403, 10 min
  TTL), serves the app + data same-origin, and gates all `/api/*` behind auth. Startup
  self-test prints reachability. Serves **`../frontend`** statically (MIME + path-traversal
  guard; `.js` → `text/javascript` for ES modules).
  - `GET /` → `frontend/index.html`; `GET /css/*`, `GET /js/*` → static assets.
  - `GET /api/indices` → JSON keyed by index name. Dashboard indices (`DASH_INDICES` =
    `alerts.INDICES`): **NIFTY 50, NIFTY NEXT 50, NIFTY MIDCAP 50, NIFTY MIDCAP 100**
    (full 100).
- **`frontend/`** - vanilla JS + CSS, **no build step**. `index.html` is markup only +
  `<link>`s to **`css/{base,components,dashboard,alerts,auth}.css`** + one
  `<script type="module" src="js/main.js">`. `js/` modules: `main` (entry, imports the
  rest) → `dashboard.js`, `alerts-ui.js`, `auth-ui.js` (cross-module bridges via `window.*`:
  `openCreateAlert`, `APP_AUTH`, `__initDash`/`__initAlerts`). Uses **Lucide** from a CDN
  (`cdn.jsdelivr.net/npm/lucide`) - the only external dep; degrades gracefully if offline.
- **`backend/alerts.js`** - alert engine + storage + Telegram sender. `server.js` runs
  `alertTick()` on an interval (`ALERT_POLL_SECONDS`, default 5) **only during market
  hours**, calling `alerts.evaluate(payload)` - so alerts fire server-side even with no
  browser tab open.
  - **Storage**: in-memory `store` (`{ alerts, archived, symbols }`) is the runtime source
    of truth; `save()` writes through to a backend. Backend = **MongoDB Atlas** if
    `mongo.uri` is set in `config.json` (read in `loadConfig()`) and reachable — a
    **per-record schema**: collection **`alerts`** (one doc per active alert, `_id = id`),
    **`archived_alerts`** (one doc per closed alert, moved on close so the active list
    stays small), **`meta`** (`{_id:"symbols"}` cache) — else the local **`alerts.json`**
    file (now `{ alerts, archived, symbols }`). Atlas gives cross-device access; it
    **always also writes `alerts.json`** as an offline cache and **falls back** to it if
    Atlas is down. The `mongodb` driver is required lazily, so file mode needs no
    `node_modules` (`npm install` only for Atlas). `load()` runs `migrate()` (backfills new
    fields, resets pre-entry outcomes, moves stray `closed` → archived).
  - **Error log**: persistence/connection/Telegram failures (`mongo.connect`, `mongo.write`,
    `file.write`, `telegram.send`) are appended to **`logs/alerts-errors.log`** via
    `logError(scope, err)` — dated lines `[YYYY-MM-DD HH:MM:SS IST] ERROR [scope] msg` — and
    echoed to the console. Failures never blank the app (in-memory + `alerts.json` stay good).

- **`backend/auth.js`** - user accounts (scrypt + per-user salt), in-memory sessions
  (HttpOnly `sid` cookie, 12h idle), roles **admin/editor/viewer**, login rate-limit; users
  in Mongo `users` collection or local `users.json`. Server-side gate: every `/api/*`
  needs a session (login/setup excepted); alert writes need editor/admin; `/api/users*`
  admin-only; non-GET requires an `X-Requested-With` header (CSRF). First run shows a
  Create-admin screen. `ALERTS_NO_TICK=1` pauses the eval loop (serve UI/APIs only).

Run: `node backend/server.js` (or `./run.sh`) → open http://localhost:8787/ (`PORT` env
var to change port).

## Alerts

Price alerts across all indices. The **Alerts** view shows a single full-width list of
**all indices together** (each row tagged with its index; no index tabs); **create/edit
happen in a modal** (`#alertModal`, opened by the "New alert" button or a row's Edit;
closed via ✕ / Cancel / backdrop / Esc). The create-form index dropdown and the stock
dropdown are **dynamic**: they read the shared index list (`alerts.INDICES`, served via
`GET /api/alert-config`), so alerts cover **all dashboard indices** automatically, and
each index's stock list is refreshed from the feed on every
market tick (i.e. daily) via `updateSymbols()` → `GET /api/symbols`.

**Required inputs**: index, stock (searchable), side (Buy/Sell), alert price, **stop loss**,
**note**, **zone creator**, **time frame** (1s…12mo, drives the offset - see below).
**Optional metadata** (stored/shown/sent, does not affect firing): candle date, candle
time (HH:MM IST, 24h). The form's trigger preview stays blank until side + alert price +
time frame are all chosen (Side/Time frame default to an empty "Select…").

**Model: the alert price is the entry/target; the trigger is offset% away from it, and
re-alerts step BACK toward the alert price.** BUY trigger = `alertPrice + offset%`
(above); SELL trigger = `alertPrice − offset%` (below). The offset **scales with the time
frame** (`OFFSETS` in `alerts.js`; anchor 2h = 10%, e.g. 1m = 0.5%, 15m = 3%, 1h = 7%,
1d = 20%). The re-alert step is **0.5% for 1m–15m** frames, else offset ÷ 5. Both are
snapshotted onto the alert at create/edit (`offsetPct`, `stepPct`); the offset map is
served at `GET /api/alert-config` for the form preview.

**Lifecycle (single gated FSM): `armed → triggered → active → closed`** (+ an `entered`
bool = reached `active`). The engine (`evaluate`) runs one state machine per tick:

- **Re-anchor** at create/edit (or first live tick): if the live price is **between the
  alert price and the trigger**, set **trigger = current price** (`reanchorTrigger` +
  `latestPrices`; form previews via `GET /api/price`).
- **armed** → price reaches the trigger (BUY rises / SELL falls) ⇒ **TRIGGER** (rings).
- **triggered** → price steps **stepPct back toward the alert price** ⇒ **RE-ALERT** (rings).
- **armed/triggered** → price **touches the alert price** (BUY falls to it / SELL rises to
  it) ⇒ **ENTRY** (🎯, silent, no prompt) and `status = active`. This is the **entry gate**.
- **The zone machine (`evaluateZone`) runs ONLY when `active`** — so 3×/5×/stop-loss can
  never fire before the price actually reaches the entry.

**Profit targets & zone outcome** (only evaluated once `active`). R = |alert − stop loss|;
**3× target** = alert ±3R, **5× target** = alert ±5R (BUY +, SELL −); profits = 3R/5R
(`targetsFor` → `riskR, target3, target5, profit3, profit5`). `evaluateZone()` sets
**`zoneOutcome`**: **fail** (SL hit while pending), **partial** (3× target), **success**
(5× target). **Terminal outcomes auto-close** (no manual action): **success** (5×) and
**fail** (SL). If **partial then SL**, the alert closes but **keeps `partial`** status
(`SL_AFTER_PARTIAL`). ENTRY/PARTIAL/SUCCESS/FAIL are **silent notifications** (no
Snooze/Close prompt); only TRIGGER/RE-ALERT ring (`RINGS` in `alerts.js`). At create/edit,
if the live price is **already past the entry**, the alert is marked `entered`
(`markEnteredIfPastEntry`); the create form confirms this first.

Every fire goes to **Telegram** (all recipients) **and** the in-page notification center;
ringing fires also toast + beep. **Snooze** clears the current ring; **Close** deactivates.
On close (manual, or auto via success/fail) the alert is **moved from `alerts` to
`archived_alerts`** (Mongo) / `store.archived` (file) — see Storage. Each alert has a
**`zoneVerified`** review flag and metadata **`createdAt` / `updatedAt` / `lastFiredAt`**
(shown in the detail modal). The list has **multi-select filter dropdowns** (index /
status [armed/triggered/active/closed] / side / time frame / zone-verified / outcome) +
a **Show archived** toggle; active selections show as removable **chips**.

Telegram is optional/dormant until configured in `config.json`
(`{ "telegram": { "botToken": "...", "recipients": [{ "chatId": "...", "label": "..." }] } }`);
missing config → in-page only. Alert API: `GET/POST /api/alerts`, `PATCH/DELETE
/api/alerts/:id`, `POST /api/alerts/:id/{snooze,close,verify,unverify}`,
`GET /api/alerts/active`, **`GET /api/alerts/all`** (active + archived, used by the
notification center), **`GET /api/alerts/archived`**, `GET /api/symbols`,
`GET /api/alert-config`, `GET /api/price`. **`ALERTS_NO_TICK=1`** env pauses the server's
alert evaluation (serves UI + APIs only) — for local testing without firing/writing.

## Data source (`fetchAllIndices()` → `fetchIndexNext()`)

Endpoints are **not hardcoded or in the repo** — the base host, index endpoint, referer,
and warmup paths are read from `config.json`'s **`feed`** block (`loadFeedConfig()`; see
`config.example.json`; `config.json` is gitignored). `server.js` errors clearly if it's
missing.

One call per index, in parallel - no fallback, no merging, no derived fields. The response
gives the index row (`priority:1`) + **all** constituents (full 100 for NIFTY MIDCAP 100)
with `symbol, companyName, open, dayHigh, dayLow, lastPrice, previousClose, change,
pChange, totalTradedVolume, totalTradedValue, yearHigh, yearLow, nearWKH/nearWKL,
perChange30d/365d`; plus `aduCount` (adv/dec/unch), `marketStatus`, `timestamp`. Index row
→ `level`; the rest → `data`. Used **as provided**; returns last-close data with
`marketStatus: Closed` off-hours.

Constituent rows also carry `companyName, totalTradedValue (turnover), yearHigh, yearLow,
nearWKH/nearWKL (% from 52W high/low), perChange30d, perChange365d`; the `level` adds
`yearHigh/yearLow/perChange30d/perChange365d`. The dashboard surfaces these via a
**click-a-row detail modal** (`openStockModal`) and on the index cards - not as extra
table columns.

Per-index payload shape:
`{ source, timestamp, marketDataLive, level:{last,variation,pChange,open,high,low,prevClose},
   advance:{advances,declines,unchanged}, data:[{symbol,open,dayHigh,dayLow,lastPrice,prevClose,change,pChange,totalTradedVolume}] }`

## Features / UI

Layout: sticky **app bar** (brand · market status · Dashboard/Alerts switch) → **KPI
index cards** (one per index - level, ±/%, O/H/L/Prev, 52W H/L, 1Y; the cards **double as
the index selector**, active one highlighted) → **toolbar** (filter tabs left; auto-poll /
time / refresh right) → **table panel** (heading with active index + advance-decline +
last-updated, compact legend, scrollable table) → footer. Click a row → stock detail
modal; its **Add alert** button opens the create-alert modal prefilled with the index +
symbol (`window.openCreateAlert(index, symbol)` bridges the dashboard → alerts scripts).

- **KPI cards are the index picker**; **filter tabs** = All / Open=High / Open=Low / Neutral;
  **search box** filters the current index's table by symbol / company name (combines with filters).
- Table columns: Symbol, LTP, Open, High, Low, Prev Close, Change (₹ + %), Volume -
  **every column sortable** asc/desc. Symbol hover shows Open→High % and Open→Low %.
- Row colour: red = Open = High, green = Open = Low. Guard divide-by-zero (open==0 → "-").
- Market-hours-aware auto-poll (1–10 s, IST), manual refresh, 12h/24h clock.
- In-memory cache with stale indicator; light/dark; full-height layout on ≥820px
  (only the table scrolls).

## Agents (`.claude/agents/`) & workflow

Single-responsibility roster. **Opus** (reason/R&D/design/review, high effort) ·
**Sonnet** (code generation, high effort):

- **nifty-explorer** (Opus) - map the actual code relevant to a request, `file:line` cited.
- **nifty-researcher** (Opus) - verify external/behavioural facts (only what code can't answer).
- **nifty-architect** (Opus) - spec + task breakdown (backend/frontend/needsUI/risks/
  verification/openQuestions). No code.
- **nifty-ui-designer** (Opus) - UI/UX design spec grounded in the CSS design system.
- **nifty-reviewer** (Opus) - adversarial verification of finished work vs spec.
- **nifty-backend** (Sonnet) - implement `server.js`/`alerts.js`/`auth.js` (backend/*) to spec.
- **nifty-frontend** (Sonnet) - implement `index.html` / `frontend/js|css` to design+spec.

**Workflow** `.claude/workflows/feature.js` (invoke with `args:{request:"..."}`): a
deterministic, module-aware pipeline — Explore → Plan (openQuestions gate) → Design? →
Backend → Frontend → Review → bounded fix loop → report. Anti-hallucination: everything
anchored to the explorer's real `file:line` map, structured schema per phase,
read-before-edit, honest verification (no fabricated results), reviewer re-verifies claims,
never destructive git, endpoints only from `config.json` `feed`.
