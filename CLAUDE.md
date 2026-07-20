# Trading Tracker - Nifty-50 Open/High/Low Dashboard

A tool to track each Nifty-50 stock's intraday movement **relative to its open price**.

## Requirements (locked)

- **Deliverable:** a single self-contained, responsive `index.html` (vanilla JS + inline CSS). No backend, no build step, no install. Runs on any device (phone/tablet/desktop) by double-click or static hosting.
- **Data source:** NSE India (unofficial) - `https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050` (all 50 constituents in one call). NSE blocks direct browser calls (**CORS**), so a CORS proxy is required - R&D verifies the working one.
- **Live daily data**, cached in memory so a transient fetch failure doesn't blank the table (show "last updated / stale").

### Metrics per stock (computed in JS)

- Open→High % = `(dayHigh-open)/open*100`
- Open→Low % = `(dayLow-open)/open*100`
- Current vs open % = `(lastPrice-open)/open*100`
- Guard divide-by-zero (open==0 pre-market → show "-").

### Features

- Configurable **auto-poll interval in seconds**; polling runs automatically during market hours (no manual start).
- Configurable **time format** (12h/24h, IST).
- **Manual refresh** button (independent of the auto-poll timer).
- Market-hours aware: IST 09:15–15:30, Mon–Fri; pause + indicate when closed, but still allow manual refresh.
- **Every column sortable** asc/desc (symbol, open, high, low, last, change %, volume, and the 3 computed metrics) with a direction indicator.
- Color-code up/down (green/red); clean, mobile-friendly layout.

## Workflow / Agents

Two project agents live in `.claude/agents/`:

- **nifty-rnd** - R&D: verify the CORS-proxy fetch approach, confirm JSON field names, recommend poll interval, market-hours logic, edge cases. Produces a spec. Does NOT write the app.
- **nifty-coder** - implementation (runs on **Sonnet 5**): builds `index.html` from the R&D spec.

Run order: **nifty-rnd → nifty-coder**. Output goes to `~/playground/trading-tracker/index.html`.

## Status

**Built.** Architecture decision (2026-07-05): a pure-browser `index.html` can no longer
reach NSE live - CORS forbids the required headers, JS can't warm NSE's anti-bot cookies,
and public CORS proxies are now dead/paywalled (corsproxy.io paid, allorigins/thingproxy
time out on NSE). Verified empirically. So per user decision we use a **tiny local proxy**.

Files (Node-only; Python was dropped per user 2026-07-05):

- `server.js` - Node, ZERO dependencies (built-in fetch + hand-rolled cookie jar), no npm install.
  Warms the NSE session (cookies + browser headers, rewarm-on-403, TTL 10 min - same approach as
  finance repo's `nse.py`), serves `index.html` at `/` and live JSON at `/api/nifty50`, same-origin
  (no browser CORS). Runs a startup self-test that prints pass/fail. Run: `node server.js`
  (Note on Axios: it can't help in the browser - CORS; and Axios in Node needs an npm install for a
  cookie jar. So we used Node's built-in fetch to keep it install-free. Needs Node 18+ for fetch.)
- `index.html` - vanilla-JS/inline-CSS dashboard: sortable columns, O→High/O→Low/Cur-vs-Open
  metrics vs open, IST market-hours-aware auto-poll, manual refresh, 12h/24h, in-memory cache
  with stale indicator, light/dark.

Run: `node server.js` → open http://localhost:8787/ (on Chromebook: run inside Linux/Crostini)

DATA SOURCE (verified live 2026-07-06, market hours): `/api/equity-stockIndices` is **dead**
(404s since 2026-05, confirmed by finance repo). Pure-live-NSE solution merges TWO endpoints:

- `/api/heatmap-symbols?indices=NIFTY 50` - all 50 live, fields: symbol, high, low, lastPrice,
  pChange, change, totalTradedVolume, VWAP, quantityTraded, lastUpdatedTime. **No `open`.**
  Returns an empty array when the market is closed (this is how we detect closed → show message).
- `/api/market-data-pre-open?key=NIFTY` - supplies `open` per symbol via the pre-open auction
  price (`metadata.iep`, == official day open, frozen at 09:15). Merged by symbol; 0 missing.
  server.js `fetchNifty()` fetches both in parallel and emits {data:[{symbol,open,dayHigh,dayLow,
  lastPrice,pChange,totalTradedVolume}], advance, timestamp, marketDataLive}. Note dead ends tried:
  heatmap-index (indices only, not stocks), heatmap-symbols?indexName=… (empty; correct param is
  `indices=`), live-analysis-variations (only 20 gainers/17 losers = 37/50). No yfinance (per user).

INDEX POINTS (added 2026-07-18): the index's own level (e.g. NIFTY 50 = 24,334.30) comes from
`/api/allIndices` — one call returns every NSE index with `last` (level), `variation` (± points),
`percentChange`, `open`/`high`/`low`/`previousClose`. Verified live 2026-07-18. Unlike
heatmap-symbols it holds the last close when the market is shut, so the headline card still renders
off-hours. server.js `fetchAllIndices()` fetches it in parallel and attaches a `level` object to
each index payload; index.html renders it as a headline card above the constituents table.
