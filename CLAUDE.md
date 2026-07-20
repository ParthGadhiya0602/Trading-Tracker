# Trading Tracker — NIFTY 50 / NIFTY NEXT 50 Dashboard

Tracks each constituent's intraday movement **relative to its open**, plus each
index's own live points level. Data is live NSE India (unofficial), market hours only
(Mon–Fri 09:15–15:30 IST).

## Architecture

A pure-browser page can't reach NSE (CORS forbids the needed headers; NSE's anti-bot
layer blocks any request without a warmed session). So there are two files:

- **`server.js`** — Node 18+, **zero dependencies** (built-in `fetch` + hand-rolled
  cookie jar). Warms an NSE session (cookies + browser headers, rewarm-on-403, 10 min
  TTL), then serves the page and data same-origin. Startup self-test prints reachability.
  - `GET /` → `index.html`
  - `GET /api/indices` → merged JSON, keyed by index name (`"NIFTY 50"`, `"NIFTY NEXT 50"`)
- **`index.html`** — vanilla JS + inline CSS dashboard. No build step.

Run: `node server.js` → open http://localhost:8787/ (`PORT` env var to change port).

## Data sources (merged by `fetchAllIndices()`)

- **`/api/heatmap-symbols?indices=<name>`** — live per-constituent high, low, lastPrice,
  change, pChange, totalTradedVolume. No `open`. Empty array = market closed.
- **`/api/market-data-pre-open?key=ALL`** — day `open` per symbol (`metadata.iep`, the
  pre-open auction price, frozen 09:15). `key=ALL` covers both indices in one call.
- **`/api/allIndices`** — each index's points **level** (`last`, `variation`,
  `percentChange`, `open`/`high`/`low`/`previousClose`). Holds last close when the
  market is shut, so the headline cards still render off-hours.

Per-index payload shape:
`{ source, timestamp, marketDataLive, level:{last,variation,pChange,open,high,low,prevClose},
   advance:{advances,declines,unchanged}, data:[{symbol,open,dayHigh,dayLow,lastPrice,prevClose,change,pChange,totalTradedVolume}] }`

## Features

- Two **index headline cards** (both always shown): points, ±/%, and O/H/L/Prev.
- **Index picker** (NIFTY 50 / NIFTY NEXT 50) and **filter tabs** (All / Open=High /
  Open=Low / Neutral).
- Table columns: Symbol, LTP, Open, High, Low, Prev Close, Change (₹ + %), Volume —
  **every column sortable** asc/desc. Symbol hover shows Open→High % and Open→Low %.
- Row colour: red = Open = High, green = Open = Low. Guard divide-by-zero (open==0 → "-").
- Market-hours-aware auto-poll (1–10 s, IST), manual refresh, 12h/24h clock.
- In-memory cache with stale indicator; light/dark; full-height layout on ≥820px
  (only the table scrolls).

## Agents (`.claude/agents/`)

- **nifty-rnd** — R&D: verify NSE endpoints/fields, market-hours logic, edge cases.
- **nifty-coder** — implementation (Sonnet 5): builds/edits `server.js` + `index.html`.
