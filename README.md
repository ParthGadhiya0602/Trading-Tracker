# Trading Tracker — NIFTY 50 / NIFTY NEXT 50 Dashboard

A tiny, zero-dependency dashboard that tracks every **NIFTY 50** and **NIFTY NEXT 50**
stock's intraday movement **relative to its open price**, plus each index's own live
points level.

![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen) ![deps](https://img.shields.io/badge/dependencies-0-blue)

## What it does

- **Index headline cards** — live points for NIFTY 50 and NIFTY NEXT 50, each with
  ± points, % change, and Open / High / Low / Prev Close (both shown at all times).
- **Per-stock table** for the selected index with:
  - **LTP**, **Open**, **High**, **Low**, **Prev Close**
  - **Change** (₹ and %) vs previous close
  - **Volume**
  - Hover a symbol for **Open→High %** and **Open→Low %** (movement vs the open).
- **Row colouring** — red when Open = High (never traded above its open today),
  green when Open = Low (never traded below), neutral otherwise. Filter tabs:
  All / Open = High / Open = Low / Neutral.
- **Every column sortable** ascending/descending with a direction indicator.
- **Market-hours aware** — auto-polls only during IST trading (Mon–Fri
  09:15–15:30); pauses and shows *Market CLOSED* otherwise. Manual **Refresh now**
  always works.
- **Configurable** auto-poll interval (1–10 s) and clock format (12h / 24h IST).
- **In-memory cache** — a transient fetch failure keeps the last good data on screen
  with a "stale" indicator instead of blanking the table.
- **Responsive** — fills the screen on laptops/desktops (only the table scrolls);
  normal page scroll on phones. Light/dark follows your system theme.

## Why there's a server

NSE's API can't be called directly from a browser: CORS forbids the required headers,
and NSE's anti-bot layer (Akamai) blocks any request without a *warm session*
(cookies + browser-like headers). So a tiny local Node server warms an NSE session and
re-serves the data to the page from the **same origin** — no CORS, no public proxy, live data.

`server.js` has **zero npm dependencies** (built-in `fetch` + a hand-rolled cookie jar).

## Requirements

- **Node.js 18+** (needs the built-in `fetch`). Check with `node --version`.
- A network NSE will answer — home/office broadband is fine. VPNs and datacentre IPs
  are often blocked by NSE (you'll see HTTP 401/403).

## How to use

```bash
node server.js
```

Then open **http://localhost:8787/** in your browser.

On startup the server runs a self-test and prints whether it reached NSE, e.g.:

```
[NIFTY 50] level 24334.3 (+261.55, +1.09%)
OK [NIFTY 50] - got 50 constituents (NSE stamp: ...)
```

To use a different port:

```bash
PORT=9000 node server.js     # then open http://localhost:9000/
```

Stop the server with **Ctrl-C**.

> Live data flows only during market hours (Mon–Fri 09:15–15:30 IST). Outside those
> hours the index cards still show the last close, but the constituents table will be
> empty until the market opens — this is expected.

## Data sources (NSE India, via the local proxy)

| Endpoint | Provides |
| --- | --- |
| `/api/heatmap-symbols` | Live LTP / High / Low / Change / Volume per constituent |
| `/api/market-data-pre-open` | Official day **Open** (pre-open auction price) |
| `/api/allIndices` | Each index's **points level**, ± change, %, O/H/L, prev close |

The server merges these into one response served at `/api/indices`.

## Files

- `index.html` — the dashboard (vanilla JS + inline CSS, no build step).
- `server.js` — the zero-dependency Node proxy + static file server.

## Notes / limitations

- Data is **unofficial** (scraped from NSE's public site) — for personal/informational
  use, not trading decisions.
- Intended to run **locally**. Hosting the live proxy on the free cloud tiers is
  unreliable because NSE tends to block datacentre IPs.
